/**
 * Repairs serialised units that sit on an active invoice but were never recorded as sold
 * (fixed in code):
 *
 *  Adding a unit to an invoice by EDITING it saved the invoice first and then created the unit's
 *  SoldSerial row. For a unit that had been sold and returned before, that row already existed
 *  (one row per serial), the create failed, and the edit stopped there: that unit and every unit
 *  after it in the same edit stayed "in stock" — on the Serial Products list and in the sale
 *  scan — although the invoice lists them. They could be sold a second time.
 *
 *  → For every serial on an active invoice that was not returned from that invoice and is not
 *    recorded as sold on it: the SoldSerial row is set to sold on that invoice, a "sold" history
 *    line is added, and the serial index and StockItem row are marked sold. A serial that is on
 *    two active invoices, was returned to the supplier, or is recorded on another active invoice
 *    is only reported.
 *
 * Dry run by default: prints what would change and writes nothing. Re-running after --apply
 * finds nothing left to do.
 *
 * Usage:
 *   node src/scripts/repair-unrecorded-sold-serials.js --tenant tbm           # dry run, one tenant
 *   node src/scripts/repair-unrecorded-sold-serials.js --tenant tbm --apply   # write changes
 *   node src/scripts/repair-unrecorded-sold-serials.js                        # dry run, all tenants
 * Requires: MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const cache = require('../lib/cache');
const Sale = require('../models/Sale');
const SoldSerial = require('../models/SoldSerial');
const SalesReturn = require('../models/SalesReturn');
const SerialHistory = require('../models/SerialHistory');
const serialIndexService = require('../services/serialIndexService');
const stockItemService = require('../services/stockItemService');

function parseArgs(argv) {
    const args = { apply: false, tenant: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--tenant') args.tenant = argv[++i];
    }
    return args;
}

/** Plans the fixes for the current tenant without writing: { fixes: [{ serial, sale, name }], warnings: [] }. */
async function planTenant() {
    const plan = { fixes: [], warnings: [] };

    const sales = await Sale.find({ status: { $ne: 'voided' }, 'items.serialNumbers.0': { $exists: true } })
        .select('reference customerName createdAt items.name items.serialNumbers')
        .lean();
    const saleById = new Map(sales.map((s) => [String(s._id), s]));

    // serial -> invoice references it was returned from
    const returnedFrom = new Map();
    const returns = await SalesReturn.find({}).select('linkedInvoiceRef items.serialNumbers').lean();
    for (const r of returns) {
        for (const it of r.items || []) {
            for (const sn of it.serialNumbers || []) {
                const serial = String(sn || '').trim();
                if (!serial) continue;
                if (!returnedFrom.has(serial)) returnedFrom.set(serial, new Set());
                returnedFrom.get(serial).add(String(r.linkedInvoiceRef || '').trim());
            }
        }
    }

    // serial -> active invoices that list it and it was not returned from
    const liveSales = new Map();
    for (const sale of sales) {
        for (const item of sale.items || []) {
            for (const sn of item.serialNumbers || []) {
                const serial = String(sn || '').trim();
                if (!serial) continue;
                if (returnedFrom.get(serial)?.has(String(sale.reference || '').trim())) continue;
                if (!liveSales.has(serial)) liveSales.set(serial, []);
                liveSales.get(serial).push({ sale, name: item.name });
            }
        }
    }

    const rows = await SoldSerial.find({ serialNumber: { $in: [...liveSales.keys()] } })
        .select('serialNumber saleId status returnDestination')
        .lean();
    const rowBySerial = new Map(rows.map((r) => [String(r.serialNumber).trim(), r]));

    for (const [serial, live] of liveSales) {
        if (live.length > 1) {
            plan.warnings.push(`${serial} is on ${live.length} active invoices (${live.map((l) => l.sale.reference).join(', ')}) — check by hand`);
            continue;
        }
        const { sale, name } = live[0];
        const row = rowBySerial.get(serial);
        if (row && row.status === 'sold' && String(row.saleId) === String(sale._id)) continue; // recorded correctly
        if (row && row.status === 'sold' && saleById.has(String(row.saleId))) {
            plan.warnings.push(`${serial} is on ${sale.reference} but recorded as sold on ${saleById.get(String(row.saleId)).reference} — check by hand`);
            continue;
        }
        if (row && row.status === 'returned' && row.returnDestination === 'return_to_supplier') {
            plan.warnings.push(`${serial} is on ${sale.reference} but was returned to the supplier — check by hand`);
            continue;
        }
        plan.fixes.push({ serial, sale, name, was: row ? `${row.status}${row.returnDestination ? ` (${row.returnDestination})` : ''}` : 'no record' });
    }
    return plan;
}

async function applyPlan(tenantId, plan) {
    for (const { serial, sale } of plan.fixes) {
        const refLabel = (sale.reference || '').trim() || `Sale ${sale._id}`;
        const customerName = sale.customerName ? String(sale.customerName).trim() : '';
        await SoldSerial.findOneAndUpdate(
            { serialNumber: serial },
            { $set: { saleId: sale._id, status: 'sold', soldAt: sale.createdAt || new Date(), returnDestination: null, returnedAt: null, salesReturnId: null } },
            { upsert: true, setDefaultsOnInsert: true }
        );
        await SerialHistory.create({
            serialNumber: serial,
            eventType: 'sold',
            referenceType: 'Sale',
            referenceId: sale._id,
            referenceLabel: refLabel,
            customerName,
        });
        await serialIndexService.upsertSerialIndex(tenantId, {
            serial,
            status: 'sold',
            saleId: sale._id,
            saleReferenceSnapshot: refLabel,
            customerNameSnapshot: customerName,
        });
        await stockItemService.markSold([serial], { tenantId, saleId: sale._id, customerName, saleReference: refLabel });
    }
    await cache.bumpMany(['sales:list', 'sales:soldSerials', 'purchases:stock-list', 'purchases:list'], tenantId);
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
            if (plan.fixes.length === 0 && plan.warnings.length === 0) {
                console.log(`\n[${tenantId}] nothing to repair`);
                return;
            }
            console.log(`\n[${tenantId}] ${plan.fixes.length} unit(s) ${args.apply ? 'marked' : 'to mark'} sold`);
            plan.fixes.forEach((f) => console.log(`  ${f.sale.reference} · ${f.serial} · ${f.name || ''} (was: ${f.was})`));
            plan.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
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
