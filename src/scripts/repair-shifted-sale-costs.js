/**
 * Repairs invoice lines whose cost-at-sale was shifted by an invoice edit (fixed in code):
 *
 *  updateSale copied unit_cost_at_sale / purchaseId / purchaseItemId from the pre-edit line at
 *  the same position, so removing or reordering a line gave every later line its neighbour's
 *  cost. E.g. INV-000205 lost its top iPhone 17 and the Redmi below took the iPhone's £640
 *  cost, so the P&L showed a loss for the day.
 *
 *  → A line is "shifted" when its SKU names one purchase (`<purchaseId>-<itemId>`) but its
 *    purchaseId points at another. Its cost, purchase link and cost_missing flag are restored
 *    from the invoice's own edit history (the EDIT_SALE "before" snapshot of the same SKU whose
 *    link matched). Lines with no such snapshot are only reported. Nothing else on the invoice
 *    changes; the P&L reads these costs live, so it is correct as soon as they are.
 *
 * Dry run by default: prints what would change and writes nothing. Re-running after --apply
 * finds nothing left to do.
 *
 * Usage:
 *   node src/scripts/repair-shifted-sale-costs.js --tenant fonewarehouse           # dry run, one tenant
 *   node src/scripts/repair-shifted-sale-costs.js --tenant fonewarehouse --apply   # write changes
 *   node src/scripts/repair-shifted-sale-costs.js                                  # dry run, all tenants
 * Requires: MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const cache = require('../lib/cache');
const Sale = require('../models/Sale');
const AuditEvent = require('../models/AuditEvent');

const OID = /^[a-f0-9]{24}$/;
const money = (n) => `£${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

function parseArgs(argv) {
    const args = { apply: false, tenant: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--tenant') args.tenant = argv[++i];
    }
    return args;
}

const skuPurchaseId = (sku) => {
    const first = String(sku || '').split('-')[0];
    return OID.test(first) ? first : null;
};
const isShifted = (item) => {
    const owner = skuPurchaseId(item.sku);
    return !!(owner && item.purchaseId && String(item.purchaseId) !== owner);
};

/** Shifted lines for the current tenant: [{ sale, item, fix | null }]. */
async function planTenant() {
    const candidates = await Sale.find({ status: { $ne: 'voided' }, 'items.purchaseId': { $ne: null } })
        .select('reference occurredAt createdAt items')
        .lean();
    const plan = [];
    for (const sale of candidates) {
        const shifted = (sale.items || []).filter(isShifted);
        if (shifted.length === 0) continue;
        const edits = await AuditEvent.find({ saleId: sale._id, action: 'EDIT_SALE' })
            .sort({ occurredAtUtc: 1 })
            .select('beforeJson')
            .lean();
        // First pre-edit copy of each SKU whose purchase link still matched its SKU.
        const good = new Map();
        for (const e of edits) {
            for (const i of (e.beforeJson && e.beforeJson.items) || []) {
                if (good.has(i.sku) || isShifted(i) || !i.purchaseId) continue;
                if (String(i.purchaseId) !== skuPurchaseId(i.sku)) continue;
                good.set(i.sku, {
                    unit_cost_at_sale: Number(i.unit_cost_at_sale) || 0,
                    cost_missing: !!i.cost_missing,
                    purchaseId: new mongoose.Types.ObjectId(String(i.purchaseId)),
                    purchaseItemId: i.purchaseItemId ? new mongoose.Types.ObjectId(String(i.purchaseItemId)) : null,
                });
            }
        }
        for (const item of shifted) plan.push({ sale, item, fix: good.get(item.sku) || null });
    }
    return plan;
}

async function applyPlan(tenantId, plan) {
    for (const { sale, item, fix } of plan) {
        if (!fix) continue;
        // Targeted $set on the one line, guarded on the wrong link so a re-run or a later edit is left alone.
        await Sale.updateOne(
            { _id: sale._id, items: { $elemMatch: { _id: item._id, purchaseId: item.purchaseId } } },
            {
                $set: {
                    'items.$.unit_cost_at_sale': fix.unit_cost_at_sale,
                    'items.$.cost_missing': fix.cost_missing,
                    'items.$.purchaseId': fix.purchaseId,
                    'items.$.purchaseItemId': fix.purchaseItemId,
                },
            }
        );
    }
    await cache.bumpMany(['sales:list', 'accounts:list', 'accounts:statement'], tenantId);
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    await mongoose.connect(process.env.MONGODB_URI);
    const prefix = config.tenantDbPrefix || 'tenant_';
    const { databases } = await mongoose.connection.db.admin().listDatabases();
    let tenantDbs = databases.map((d) => d.name).filter((n) => n.startsWith(prefix));
    if (args.tenant) {
        const wanted = `${prefix}${args.tenant}`;
        if (!tenantDbs.includes(wanted)) {
            console.error(`No database ${wanted}. Tenants: ${tenantDbs.map((n) => n.slice(prefix.length)).join(', ')}`);
            process.exit(1);
        }
        tenantDbs = [wanted];
    }
    console.log(args.apply ? 'APPLY — writing changes' : 'DRY RUN — nothing will be written (pass --apply to write)');

    for (const dbName of tenantDbs) {
        const tenantId = dbName.slice(prefix.length);
        const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
        await tenantContext.run({ tenantDb, tenantId }, async () => {
            const plan = await planTenant();
            if (plan.length === 0) {
                console.log(`\n[${tenantId}] nothing to repair`);
                return;
            }
            console.log(`\n[${tenantId}]`);
            const byDay = new Map();
            for (const { sale, item, fix } of plan) {
                const day = new Date(sale.occurredAt || sale.createdAt).toISOString().slice(0, 10);
                if (!fix) {
                    console.log(`  ⚠ ${sale.reference} ${day} ${item.name}: cost ${money(item.unit_cost_at_sale)} looks shifted but has no pre-edit copy — check by hand`);
                    continue;
                }
                const delta = (fix.unit_cost_at_sale - (Number(item.unit_cost_at_sale) || 0)) * (Number(item.quantity) || 0);
                byDay.set(day, (byDay.get(day) || 0) + delta);
                console.log(`  ${sale.reference} ${day} ${item.name} x${item.quantity}: cost ${money(item.unit_cost_at_sale)} → ${money(fix.unit_cost_at_sale)}`);
            }
            for (const [day, delta] of [...byDay].sort()) {
                const up = delta >= 0;
                console.log(`  ${day}: COGS ${up ? '+' : '−'}${money(Math.abs(delta))} (gross profit ${up ? '−' : '+'}${money(Math.abs(delta))})`);
            }
            if (args.apply) await applyPlan(tenantId, plan);
        });
    }

    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
