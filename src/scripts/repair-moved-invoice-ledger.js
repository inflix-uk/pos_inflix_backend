/**
 * Repairs customer accounts damaged by the wholesale-invoice "customer changed" bug (fixed in code):
 *
 *  Editing an invoice onto another customer reversed the old customer's lines using the edited
 *  invoice (new total + new payments) instead of what the old customer was actually charged. When
 *  the same edit also changed the total or payments, the old customer kept a leftover amount and got
 *  a reversed "payment" line; the invoice also kept the old customer's previous balance.
 *    e.g. INV created on credit for £1,035, then edited to £1,305 paid in cash and moved: the old
 *    customer got −£1,305 + £1,305 back instead of −£1,035, so they still owed the £1,035.
 *
 *  → For every moved invoice: an account that no longer owns it gets one correction line so the
 *    invoice nets to £0 there (balance field adjusted too), and the invoice's previous balance /
 *    amount due / balance to pay are re-based on the owner's balance at the time it was moved.
 *    The owning account's lines are only checked, never changed.
 *
 * Dry run by default: prints what would change and writes nothing. Re-running after --apply
 * finds nothing left to do.
 *
 * Usage:
 *   node src/scripts/repair-moved-invoice-ledger.js --tenant tbm            # dry run, one tenant
 *   node src/scripts/repair-moved-invoice-ledger.js --tenant tbm --apply    # write changes
 *   node src/scripts/repair-moved-invoice-ledger.js --tenant tbm --invoice INV-001927 --apply  # one invoice
 *   node src/scripts/repair-moved-invoice-ledger.js                         # dry run, all tenants
 * Requires: MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const cache = require('../lib/cache');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const GeneralSettings = require('../models/GeneralSettings');
const { computeRemainingAmountDue } = require('../utils/wholesalePaymentAmounts');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;
const money = (n) => `£${round2(n).toFixed(2)}`;
const sum = (rows) => round2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0));

function parseArgs(argv) {
    const args = { apply: false, tenant: null, invoices: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--tenant') args.tenant = argv[++i];
        else if (argv[i] === '--invoice') args.invoices.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    }
    return args;
}

/** Plans every change for the current tenant without writing. `invoices` limits it to those references. */
async function planTenant(invoices = []) {
    const plan = {
        ledger: [],          // LedgerEntry docs to create
        balances: new Map(), // customerId -> Customer.balance delta
        sales: new Map(),    // saleId -> { previousBalance, amountDue } to set
        notes: [],
        warnings: []
    };
    const addBalance = (customerId, delta) => {
        const k = String(customerId);
        plan.balances.set(k, round2((plan.balances.get(k) || 0) + delta));
    };

    const movedIds = await LedgerEntry.distinct('referenceId', {
        accountType: 'customer',
        deletedAt: null,
        referenceLabel: /^Customer changed \((assigned|removed)\)/
    });
    if (movedIds.length === 0) return plan;

    const settings = await GeneralSettings.findOne().select('accountBalanceAtCheckoutEnabled').lean();
    const carryBalances = settings?.accountBalanceAtCheckoutEnabled !== false;
    const names = new Map();
    const nameOf = async (id) => {
        const k = String(id);
        if (!names.has(k)) {
            const c = await Customer.findById(id).select('name isWalkIn').lean();
            names.set(k, c || { name: `customer ${k}` });
        }
        return names.get(k);
    };

    const saleQuery = { _id: { $in: movedIds.filter(Boolean) }, type: 'wholesale', status: { $ne: 'voided' } };
    if (invoices.length) saleQuery.reference = { $in: invoices };
    const sales = await Sale.find(saleQuery)
        .select('reference customerId total discount payments previousBalance amountDue')
        .lean();
    for (const sale of sales) {
        const ref = sale.reference || `Sale ${sale._id}`;
        const ownerId = sale.customerId ? String(sale.customerId) : null;
        const entries = await LedgerEntry.find({ accountType: 'customer', referenceId: sale._id, deletedAt: null })
            .select('accountId amount referenceLabel createdAt')
            .lean();

        const byAccount = new Map();
        for (const e of entries) {
            const k = String(e.accountId);
            if (!byAccount.has(k)) byAccount.set(k, []);
            byAccount.get(k).push(e);
        }

        // 1. Accounts the invoice was moved away from must net to zero for it.
        for (const [accountId, rows] of byAccount) {
            if (accountId === ownerId) continue;
            const leftover = sum(rows);
            if (Math.abs(leftover) < EPS) continue;
            const now = new Date();
            plan.ledger.push({
                accountType: 'customer',
                accountId,
                accountModel: 'Customer',
                type: 'sale',
                amount: round2(-leftover),
                referenceId: sale._id,
                referenceLabel: `Customer changed (correction) - ${ref}`,
                date: now,
                occurredAt: now,
                note: 'Invoice moved to another customer; clears what was left on this account'
            });
            addBalance(accountId, -leftover);
            plan.notes.push(`Moved    ${ref} · ${(await nameOf(accountId)).name}: ${money(leftover)} left on the old account → correction ${money(-leftover)}`);
        }

        // 2. Owner's lines should equal net invoice − cash/card/bank paid (checked only).
        if (ownerId) {
            const p = sale.payments || {};
            const expected = round2((Number(sale.total) || 0) - (Number(sale.discount) || 0)
                - (Number(p.cash) || 0) - (Number(p.card) || 0) - (Number(p.bank) || 0));
            const actual = sum(byAccount.get(ownerId) || []);
            if (Math.abs(actual - expected) >= EPS) {
                plan.warnings.push(`${ref} · ${(await nameOf(ownerId)).name}: invoice lines total ${money(actual)}, expected ${money(expected)} — not changed, check by hand`);
            }
        }

        // 3. Previous balance was the old account's: use the owner's balance just before the move.
        let previousBalance = 0;
        if (ownerId && carryBalances) {
            const owner = await nameOf(ownerId);
            const assigned = (byAccount.get(ownerId) || [])
                .filter((e) => /^Customer changed \(assigned\)/.test(e.referenceLabel || ''))
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
            if (assigned && !owner.isWalkIn) {
                const before = await LedgerEntry.find({
                    accountType: 'customer',
                    accountId: ownerId,
                    deletedAt: null,
                    referenceId: { $ne: sale._id },
                    createdAt: { $lt: assigned.createdAt }
                }).select('amount').lean();
                previousBalance = sum(before);
            } else if (!assigned) {
                continue; // owner never changed (only moved away and back without an assigned line) — leave as is
            }
        }
        const amountDue = computeRemainingAmountDue({
            total: sale.total,
            discount: sale.discount,
            previousBalance,
            payments: sale.payments
        });
        const credit = round2(sale.payments?.credit);
        if (
            Math.abs(round2(sale.previousBalance) - previousBalance) >= EPS ||
            Math.abs(round2(sale.amountDue) - amountDue) >= EPS ||
            Math.abs(credit - amountDue) >= EPS
        ) {
            const was = `previous balance ${money(sale.previousBalance)}, due ${money(sale.amountDue)}, balance to pay ${money(credit)}`;
            plan.sales.set(String(sale._id), { previousBalance, amountDue });
            plan.notes.push(`Invoice  ${ref} · ${ownerId ? (await nameOf(ownerId)).name : 'no account'}: ${was} → ${money(previousBalance)} / ${money(amountDue)} / ${money(amountDue)}`);
        }
    }

    return plan;
}

async function applyPlan(tenantId, plan) {
    for (const doc of plan.ledger) await LedgerEntry.create(doc);
    for (const [customerId, delta] of plan.balances) {
        if (Math.abs(delta) >= EPS) await Customer.updateOne({ _id: customerId }, { $inc: { balance: delta } });
    }
    // Targeted $set: a full save() would re-validate unrelated legacy fields and could stop half way.
    for (const [saleId, s] of plan.sales) {
        await Sale.updateOne(
            { _id: saleId },
            { $set: { previousBalance: s.previousBalance, amountDue: s.amountDue, 'payments.credit': s.amountDue } }
        );
    }
    await cache.bumpMany(['sales:list', 'customers:list', 'accounts:list', 'accounts:statement'], tenantId);
}

/** Customer.balance vs sum of ledger for every customer the plan touches. */
async function balanceReport(plan, applied) {
    const lines = [];
    for (const [customerId, delta] of plan.balances) {
        const c = await Customer.findById(customerId).select('name balance').lean();
        if (!c) continue;
        const entries = await LedgerEntry.find({ accountType: 'customer', accountId: customerId, deletedAt: null }).select('amount').lean();
        const ledger = sum(entries);
        const stored = round2(c.balance);
        const ledgerAfter = applied ? ledger : round2(ledger + delta);
        const storedAfter = applied ? stored : round2(stored + delta);
        const drift = Math.abs(ledgerAfter - storedAfter) >= EPS ? `  ⚠ balance field ${money(storedAfter)} ≠ ledger` : '';
        lines.push(`  ${c.name}: ${applied ? 'now' : 'will be'} ${money(ledgerAfter)} (change ${delta >= 0 ? '+' : ''}${money(delta)})${drift}`);
    }
    return lines;
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
    if (args.invoices.length) console.log(`Only invoices: ${args.invoices.join(', ')}`);

    for (const dbName of tenantDbs) {
        const tenantId = dbName.slice(prefix.length);
        const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
        await tenantContext.run({ tenantDb, tenantId }, async () => {
            const plan = await planTenant(args.invoices);
            if (plan.notes.length === 0 && plan.warnings.length === 0) {
                console.log(`\n[${tenantId}] nothing to repair`);
                return;
            }
            console.log(`\n[${tenantId}]`);
            plan.notes.forEach((n) => console.log(`  ${n}`));
            plan.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
            if (args.apply) await applyPlan(tenantId, plan);
            const balances = await balanceReport(plan, args.apply);
            if (balances.length) {
                console.log('  Customer balances:');
                balances.forEach((l) => console.log(l));
            }
        });
    }

    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
