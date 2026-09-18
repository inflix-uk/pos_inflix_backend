/**
 * Repairs customer accounts damaged by two wholesale-invoice bugs (both fixed in code):
 *
 *  1. "Take payment" on an invoice (Sales list) only updated the invoice. The customer's account
 *     never got the payment: no payment_in ledger line, Customer.balance not lowered, no
 *     payment-pot IN entry. The inflated balance was then printed as "previous balance" on the
 *     customer's next invoices.
 *     → Posts the missing payment lines (dated when the payment was taken), lowers the balance,
 *       adds the pot IN entries, and lowers the previous balance / amount due on later invoices
 *       that were created while the payment was missing.
 *
 *  2. Saving an invoice from the sales edit page stored `total` with the discount already taken
 *     off, so the discount was deducted twice (910 − 90 shown as 730) and the account got a
 *     wrong −discount "Invoice adjustment".
 *     → Restores total = subtotal + tax, recomputes amount due, posts a +discount correction on
 *       the account and reverses the revenue-metric change the edit made.
 *
 * Dry run by default: prints what would change and writes nothing. Re-running after --apply
 * finds nothing left to do.
 *
 * Usage:
 *   node src/scripts/repair-customer-ledger.js --tenant fonewarehouse           # dry run, one tenant
 *   node src/scripts/repair-customer-ledger.js --tenant fonewarehouse --apply   # write changes
 *   node src/scripts/repair-customer-ledger.js                                  # dry run, all tenants
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
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const paymentAccountService = require('../services/paymentAccountService');
const metricsService = require('../services/metricsService');
const { computeRemainingAmountDue } = require('../utils/wholesalePaymentAmounts');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;
const money = (n) => `£${round2(n).toFixed(2)}`;
const day = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);

function parseArgs(argv) {
    const args = { apply: false, tenant: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--tenant') args.tenant = argv[++i];
    }
    return args;
}

/** Plans every change for the current tenant without writing. */
async function planTenant(tenantId) {
    const plan = {
        ledger: [],          // LedgerEntry docs to create
        pots: [],            // PaymentLedgerEntry docs to create
        balances: new Map(), // customerId -> delta
        sales: new Map(),    // saleId -> mutated Sale doc to save
        metrics: [],         // { locationId, date, delta }
        notes: [],           // human-readable report lines
        warnings: []
    };
    const customerNames = new Map();
    const customerName = async (id) => {
        const key = String(id);
        if (!customerNames.has(key)) {
            const c = await Customer.findById(id).select('name').lean();
            customerNames.set(key, c ? c.name : null);
        }
        return customerNames.get(key);
    };
    const addBalance = (customerId, delta) => {
        const key = String(customerId);
        plan.balances.set(key, round2((plan.balances.get(key) || 0) + delta));
    };
    const trackSale = (sale) => {
        plan.sales.set(String(sale._id), sale);
        return sale;
    };
    const now = new Date();

    // ── 1. Invoice payments that never reached the customer account ──
    const missedByCustomer = new Map(); // customerId -> [{ amount, receivedAt }]
    const withFollowUps = await Sale.find({
        type: 'wholesale',
        status: { $ne: 'voided' },
        customerId: { $ne: null },
        'paymentHistory.0': { $exists: true }
    });
    for (const sale of withFollowUps) {
        const name = await customerName(sale.customerId);
        if (name == null) continue; // supplier account or deleted customer — no customer ledger
        const p = sale.payments || {};
        const received = round2((Number(p.cash) || 0) + (Number(p.card) || 0) + (Number(p.bank) || 0));
        const posted = await LedgerEntry.find({
            accountType: 'customer',
            accountId: sale.customerId,
            referenceId: sale._id,
            type: 'payment_in',
            deletedAt: null
        }).select('amount').lean();
        const onAccount = round2(-posted.reduce((s, e) => s + (Number(e.amount) || 0), 0));
        let missing = round2(received - onAccount);
        if (missing < -EPS) {
            plan.warnings.push(`${sale.reference} (${name}): account has ${money(-missing)} more payments than the invoice — review manually`);
            continue;
        }
        if (missing < EPS) continue;

        const ref = sale.reference || `Sale ${sale._id}`;
        // Newest follow-up payments are the ones not yet on the account (an invoice edit may have
        // already reconciled older ones).
        const followUps = [...sale.paymentHistory]
            .filter((h) => h.method !== 'credit')
            .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
        for (const h of followUps) {
            if (missing < EPS) break;
            const amount = round2(Math.min(Number(h.amount) || 0, missing));
            if (amount < EPS) continue;
            missing = round2(missing - amount);
            const receivedAt = h.receivedAt || now;
            plan.ledger.push({
                accountType: 'customer',
                accountId: sale.customerId,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: round2(-amount),
                referenceId: sale._id,
                referenceLabel: `${ref} payment`,
                date: receivedAt,
                occurredAt: receivedAt,
                paymentMethod: h.method,
                note: h.note || 'Payment taken on invoice',
                createdBy: h.receivedBy || null
            });
            addBalance(sale.customerId, -amount);
            if (!missedByCustomer.has(String(sale.customerId))) missedByCustomer.set(String(sale.customerId), []);
            missedByCustomer.get(String(sale.customerId)).push({ amount, receivedAt });

            const potExists = await PaymentLedgerEntry.exists({
                entityType: 'Sale', entityId: sale._id, direction: 'in', method: h.method, amount, occurredAtUtc: receivedAt
            });
            const potId = potExists ? null : await paymentAccountService.getPaymentAccountIdForMethod(tenantId, h.method, sale.locationId);
            if (potId) {
                plan.pots.push({
                    tenantId,
                    occurredAtUtc: receivedAt,
                    accountId: potId,
                    method: h.method,
                    direction: 'in',
                    amount,
                    entityType: 'Sale',
                    entityId: sale._id,
                    locationId: sale.locationId || undefined,
                    createdByUserId: h.receivedBy || undefined
                });
            }
            plan.notes.push(`Payment   ${ref} · ${name}: ${money(amount)} ${h.method} taken ${day(receivedAt)} → add to account`);
        }
        if (missing >= EPS) {
            plan.warnings.push(`${ref} (${name}): ${money(missing)} of invoice payments is not on the account and doesn't match any follow-up payment — review manually`);
        }
    }

    // Later invoices printed a previous balance that still included the missing payments.
    for (const [customerId, missed] of missedByCustomer) {
        const later = await Sale.find({
            type: 'wholesale',
            status: { $ne: 'voided' },
            customerId,
            previousBalance: { $gt: 0 }
        });
        for (const s of later) {
            const overstated = round2(missed
                .filter((m) => new Date(m.receivedAt) < new Date(s.createdAt))
                .reduce((sum, m) => sum + m.amount, 0));
            if (overstated < EPS) continue;
            const sale = plan.sales.get(String(s._id)) || trackSale(s);
            const correction = round2(Math.min(overstated, Number(sale.previousBalance) || 0));
            const before = { prev: round2(sale.previousBalance), due: round2(sale.amountDue) };
            sale.previousBalance = round2(before.prev - correction);
            sale.amountDue = round2(Math.max(0, before.due - correction));
            plan.notes.push(`Prev bal  ${sale.reference} · ${await customerName(customerId)}: previous balance ${money(before.prev)} → ${money(sale.previousBalance)}, amount due ${money(before.due)} → ${money(sale.amountDue)}`);
        }
    }

    // ── 2. Discount deducted twice by the sales edit page ──
    const discounted = await Sale.find({ status: { $ne: 'voided' }, discount: { $gt: 0 } });
    for (const s of discounted) {
        const sale = plan.sales.get(String(s._id)) || s;
        const gross = round2((Number(sale.subtotal) || 0) + (Number(sale.tax) || 0));
        const discount = round2(sale.discount);
        const total = round2(sale.total);
        if (Math.abs(total - round2(gross - discount)) > EPS || Math.abs(total - gross) < EPS) continue;
        trackSale(sale);
        const delta = round2(gross - total);
        const before = { total, due: round2(sale.amountDue) };
        sale.total = gross;
        if (sale.type === 'wholesale') {
            sale.amountDue = computeRemainingAmountDue({
                total: sale.total,
                discount: sale.discount,
                previousBalance: sale.previousBalance,
                payments: sale.payments
            });
        }
        const name = sale.customerId ? await customerName(sale.customerId) : null;
        if (sale.type === 'wholesale' && name != null) {
            plan.ledger.push({
                accountType: 'customer',
                accountId: sale.customerId,
                accountModel: 'Customer',
                type: 'sale',
                amount: delta,
                referenceId: sale._id,
                referenceLabel: `Invoice adjustment - ${sale.reference}`,
                date: now,
                occurredAt: now,
                note: 'Correction: discount was deducted twice when the invoice was edited',
                createdBy: null
            });
            addBalance(sale.customerId, delta);
        }
        plan.metrics.push({ locationId: sale.locationId || null, date: sale.occurredAt || sale.createdAt, delta });
        plan.notes.push(`Discount  ${sale.reference} · ${name || sale.customerName || 'no account'}: total ${money(before.total)} → ${money(sale.total)} (discount ${money(discount)} was taken twice), amount due ${money(before.due)} → ${money(sale.amountDue)}${name != null ? `, account +${money(delta)}` : ''}`);
    }

    return plan;
}

async function applyPlan(tenantId, plan) {
    for (const doc of plan.ledger) await LedgerEntry.create(doc);
    for (const doc of plan.pots) await PaymentLedgerEntry.create(doc);
    for (const [customerId, delta] of plan.balances) {
        if (Math.abs(delta) >= EPS) await Customer.updateOne({ _id: customerId }, { $inc: { balance: delta } });
    }
    for (const sale of plan.sales.values()) await sale.save();
    for (const m of plan.metrics) await metricsService.saleTotalEditDelta(tenantId, m.locationId, m.date, m.delta);
    await cache.bumpMany(['sales:list', 'customers:list', 'paymentAccounts:list', 'accounts:list', 'accounts:statement'], tenantId);
}

/** Customer.balance vs sum of ledger for every customer the plan touches. */
async function balanceReport(plan, applied) {
    const lines = [];
    for (const [customerId, delta] of plan.balances) {
        const c = await Customer.findById(customerId).select('name balance').lean();
        if (!c) continue;
        const entries = await LedgerEntry.find({ accountType: 'customer', accountId: customerId, deletedAt: null }).select('amount').lean();
        const ledger = round2(entries.reduce((s, e) => s + (Number(e.amount) || 0), 0));
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

    for (const dbName of tenantDbs) {
        const tenantId = dbName.slice(prefix.length);
        const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
        await tenantContext.run({ tenantDb, tenantId }, async () => {
            const plan = await planTenant(tenantId);
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
