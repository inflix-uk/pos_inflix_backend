const LedgerEntry = require('../models/LedgerEntry');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Purchase = require('../models/Purchase');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const BankAccount = require('../models/BankAccount');
const Expense = require('../models/Expense');
const Location = require('../models/Location');
const mongoose = require('mongoose');
const asyncHandler = require('../middleware/asyncHandler');
const auditService = require('../services/auditService');
const activityLogService = require('../services/activityLogService');
const redis = require('../lib/redis');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const { formatSupplierLabel } = require('../utils/supplierDisplay');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const ACCOUNTS_CACHE_NAMESPACES = ['accounts:list', 'accounts:statement'];
async function invalidateAccountsCaches(tenantId) {
    await cache.bumpMany(ACCOUNTS_CACHE_NAMESPACES, tenantId);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// @desc    Record customer payment (reduces balance)
// @route   POST /api/accounts/customer-payment
// @access  Private
exports.recordCustomerPayment = asyncHandler(async (req, res) => {
    const { customerId, amount, paymentMethod, note, date } = req.body;
    if (!customerId || amount == null || Number(amount) <= 0) {
        return res.status(400).json({
            success: false,
            message: 'customerId and a positive amount are required'
        });
    }
    const payAmount = round2(Number(amount));
    const customer = await Customer.findById(customerId);
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    // Source of truth = sum of live ledger entries (this is what the statement page shows).
    // The Customer.balance doc field can drift from the ledger over time; reconcile it here so
    // validation matches what the user sees on screen.
    const ledgerEntries = await LedgerEntry.find({
        accountType: 'customer',
        accountId: customerId,
        deletedAt: null
    }).select('amount').lean();
    const currentBalance = round2(ledgerEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
    if (round2(Number(customer.balance) || 0) !== currentBalance) {
        customer.balance = currentBalance;
    }
    // Overpayment is allowed: leftover becomes store credit (negative customer.balance).
    const entry = await LedgerEntry.create({
        accountType: 'customer',
        accountId: customerId,
        accountModel: 'Customer',
        type: 'payment_in',
        amount: round2(-payAmount),
        referenceLabel: `Payment ${paymentMethod || 'cash'}`,
        date: date ? new Date(date) : new Date(),
        paymentMethod: paymentMethod || 'cash',
        note: note || '',
        createdBy: req.user?.id
    });
    customer.balance = round2(currentBalance - payAmount);
    await customer.save();
    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'Payment', entry._id, 'PAYMENT', { after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADDED',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Customer payment ${payAmount.toFixed(2)} (${paymentMethod || 'cash'})`,
        customerId,
        amount: payAmount,
        paymentMethod: paymentMethod || 'cash',
        afterJson: entry.toObject()
    });
    const tenantId = getTenantIdFromReq(req);
    await invalidateAccountsCaches(tenantId);
    await cache.bumpNs('customers:list', tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    res.status(201).json({
        success: true,
        message: 'Payment recorded',
        data: { balance: round2(customer.balance) }
    });
});

// @desc    Record refund to customer (when they have store credit - pay them from credit)
// @route   POST /api/accounts/customer-refund
// @access  Private
exports.recordCustomerRefund = asyncHandler(async (req, res) => {
    const { customerId, amount, paymentMethod, note, date } = req.body;
    if (!customerId || amount == null || Number(amount) <= 0) {
        return res.status(400).json({
            success: false,
            message: 'customerId and a positive amount are required'
        });
    }
    const refundAmount = round2(Number(amount));
    const customer = await Customer.findById(customerId);
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    // Reconcile against the live ledger sum (same source of truth the statement page shows).
    const ledgerEntries = await LedgerEntry.find({
        accountType: 'customer',
        accountId: customerId,
        deletedAt: null
    }).select('amount').lean();
    const currentBalance = round2(ledgerEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
    if (round2(Number(customer.balance) || 0) !== currentBalance) {
        customer.balance = currentBalance;
    }
    if (currentBalance >= 0) {
        return res.status(400).json({
            success: false,
            message: 'Customer has no store credit to refund. Refund only when balance is in credit.'
        });
    }
    const creditAvailable = round2(-currentBalance);
    if (refundAmount > creditAvailable) {
        return res.status(400).json({
            success: false,
            message: `Refund (${refundAmount.toFixed(2)}) exceeds store credit (${creditAvailable.toFixed(2)})`
        });
    }
    const entry = await LedgerEntry.create({
        accountType: 'customer',
        accountId: customerId,
        accountModel: 'Customer',
        type: 'refund',
        amount: refundAmount,
        referenceLabel: `Refund ${paymentMethod || 'cash'}`,
        date: date ? new Date(date) : new Date(),
        paymentMethod: paymentMethod || 'cash',
        note: note || '',
        createdBy: req.user?.id
    });
    customer.balance = round2(currentBalance + refundAmount);
    await customer.save();
    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'Refund', entry._id, 'REFUND', { after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'REFUND_ADDED',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Customer refund ${refundAmount.toFixed(2)} (${paymentMethod || 'cash'})`,
        customerId,
        amount: refundAmount,
        paymentMethod: paymentMethod || 'cash',
        afterJson: entry.toObject()
    });
    res.status(201).json({
        success: true,
        message: 'Refund recorded',
        data: { balance: round2(customer.balance) }
    });
});

// @desc    Adjust account balance (customer or supplier) — creates opening_balance ledger entry.
// @route   POST /api/accounts/balance-adjustment
// @access  Private
exports.recordBalanceAdjustment = asyncHandler(async (req, res) => {
    const { accountType, accountId, amount, direction, note, date } = req.body;
    if (!accountType || !['customer', 'supplier'].includes(accountType)) {
        return res.status(400).json({ success: false, message: 'accountType must be customer or supplier' });
    }
    if (!accountId || amount == null || Number(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'accountId and a positive amount are required' });
    }
    const dir = direction === 'subtract' ? -1 : 1;
    const adjustAmount = round2(Number(amount));
    const signedAmount = round2(dir * adjustAmount);

    const accountModel = accountType === 'customer' ? 'Customer' : 'Supplier';
    const Model = accountType === 'customer' ? Customer : Supplier;
    const account = await Model.findById(accountId);
    if (!account) {
        return res.status(404).json({ success: false, message: `${accountModel} not found` });
    }

    const entry = await LedgerEntry.create({
        accountType,
        accountId,
        accountModel,
        type: 'opening_balance',
        amount: signedAmount,
        referenceLabel: dir > 0 ? 'Balance added' : 'Balance reduced',
        date: date ? new Date(date) : new Date(),
        note: note || '',
        createdBy: req.user?.id
    });

    if (accountType === 'customer') {
        const currentBalance = round2(Number(account.balance) || 0);
        account.balance = round2(currentBalance + signedAmount);
        await account.save();
    }

    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'LedgerEntry', entry._id, 'PAYMENT_ADJUSTMENT', { after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADJUSTMENT',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `${accountType} balance ${dir > 0 ? 'added' : 'reduced'} ${adjustAmount.toFixed(2)}`,
        amount: adjustAmount,
        metaJson: { accountType, accountId: String(accountId), direction: dir > 0 ? 'add' : 'subtract' },
        afterJson: entry.toObject()
    });

    res.status(201).json({
        success: true,
        message: 'Balance adjusted',
        data: { entryId: entry._id }
    });
});

const EDITABLE_LEDGER_TYPES = new Set(['opening_balance', 'payment_in', 'payment_out', 'refund']);

// @desc    Update a manual ledger entry (amount/note/paymentMethod/date). Reverses & reapplies customer balance.
// @route   PUT /api/accounts/ledger-entry/:id
// @access  Private
exports.updateLedgerEntry = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, note, paymentMethod, date } = req.body;
    const entry = await LedgerEntry.findById(id);
    if (!entry || entry.deletedAt) {
        return res.status(404).json({ success: false, message: 'Ledger entry not found' });
    }
    if (!EDITABLE_LEDGER_TYPES.has(entry.type)) {
        return res.status(400).json({ success: false, message: `Entries of type "${entry.type}" cannot be edited from here` });
    }

    const before = entry.toObject();
    const oldAmount = round2(Number(entry.amount) || 0);
    let newAmount = oldAmount;
    if (amount != null) {
        const absAmount = round2(Math.abs(Number(amount)));
        if (!(absAmount > 0)) {
            return res.status(400).json({ success: false, message: 'Amount must be positive' });
        }
        const sign = oldAmount < 0 ? -1 : 1;
        newAmount = round2(sign * absAmount);
    }
    entry.amount = newAmount;
    if (note !== undefined) entry.note = note || '';
    if (paymentMethod !== undefined) entry.paymentMethod = paymentMethod || '';
    if (date) entry.date = new Date(date);
    await entry.save();

    if (entry.accountType === 'customer') {
        const customer = await Customer.findById(entry.accountId);
        if (customer) {
            const cur = round2(Number(customer.balance) || 0);
            customer.balance = round2(cur - oldAmount + newAmount);
            await customer.save();
        }
    }

    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'LedgerEntry', entry._id, 'PAYMENT_ADJUSTMENT', { before, after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADJUSTMENT',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Ledger entry updated (${entry.type})`,
        amount: Math.abs(newAmount),
        beforeJson: before,
        afterJson: entry.toObject()
    });

    res.status(200).json({ success: true, message: 'Ledger entry updated', data: entry.toObject() });
});

// @desc    Delete a manual ledger entry. Reverses customer balance.
// @route   DELETE /api/accounts/ledger-entry/:id
// @access  Private
exports.deleteLedgerEntry = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const entry = await LedgerEntry.findById(id);
    if (!entry || entry.deletedAt) {
        return res.status(404).json({ success: false, message: 'Ledger entry not found' });
    }
    if (!EDITABLE_LEDGER_TYPES.has(entry.type)) {
        return res.status(400).json({ success: false, message: `Entries of type "${entry.type}" cannot be deleted from here` });
    }
    const before = entry.toObject();
    const amount = round2(Number(entry.amount) || 0);

    if (entry.accountType === 'customer') {
        const customer = await Customer.findById(entry.accountId);
        if (customer) {
            const cur = round2(Number(customer.balance) || 0);
            customer.balance = round2(cur - amount);
            await customer.save();
        }
    }

    entry.deletedAt = new Date();
    entry.deletedBy = req.user?.id || null;
    await entry.save();

    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'LedgerEntry', entry._id, 'DELETE', { before });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADJUSTMENT',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Ledger entry deleted (${entry.type})`,
        amount: Math.abs(amount),
        beforeJson: before
    });

    res.status(200).json({ success: true, message: 'Ledger entry deleted' });
});

// @desc    Get customer account statement (ledger lines + balance)
// @route   GET /api/accounts/customer/:id/statement
// @access  Private
exports.getCustomerStatement = asyncHandler(async (req, res) => {
    const customerId = req.params.id;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const match = { accountType: 'customer', accountId: customerId, deletedAt: null };
    if (from && to) match.date = { $gte: from, $lte: to };
    else if (from) match.date = { $gte: from };
    else if (to) match.date = { $lte: to };

    // Run customer lookup and ledger query in parallel
    const [customer, entries] = await Promise.all([
        Customer.findById(customerId).select('name balance').lean(),
        LedgerEntry.find(match).sort({ date: -1 }).lean()
    ]);

    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    // Ensure balance is a number (imported balance lives on Customer when ledger may not have opening_balance yet)
    if (customer.balance != null && typeof customer.balance !== 'number') {
        customer.balance = round2(Number(customer.balance));
    }

    // Aggregate sale entries by referenceId so one line per invoice (no duplicate rows for same sale/edit)
    const saleEntries = entries.filter((e) => e.type === 'sale' && e.referenceId);
    const otherEntries = entries.filter((e) => e.type !== 'sale' || !e.referenceId);
    const saleByRef = new Map();
    saleEntries.forEach((e) => {
        const ref = String(e.referenceId);
        if (!saleByRef.has(ref)) {
            saleByRef.set(ref, { _id: e._id, type: 'sale', amount: 0, referenceLabel: e.referenceLabel, date: e.date, referenceId: ref });
        }
        const row = saleByRef.get(ref);
        row.amount = round2((row.amount || 0) + (Number(e.amount) || 0));
        if (new Date(e.date) < new Date(row.date)) row.date = e.date;
    });
    const aggregatedSales = Array.from(saleByRef.values());

    // Which sales have been edited (updatedAt > createdAt)
    const saleRefIds = aggregatedSales.map((s) => s.referenceId);
    let editedSaleIds = new Set();
    if (saleRefIds.length > 0) {
        const sales = await Sale.find({ _id: { $in: saleRefIds } }).select('_id updatedAt createdAt').lean();
        const EDIT_THRESHOLD_MS = 5000;
        sales.forEach((s) => {
            const created = new Date(s.createdAt).getTime();
            const updated = new Date(s.updatedAt).getTime();
            if (updated - created > EDIT_THRESHOLD_MS) editedSaleIds.add(String(s._id));
        });
    }

    const saleLines = aggregatedSales.map((s) => ({
        _id: s._id,
        type: s.type,
        amount: round2(s.amount),
        referenceLabel: s.referenceLabel,
        date: s.date,
        paymentMethod: undefined,
        note: undefined,
        isEdited: editedSaleIds.has(s.referenceId)
    }));
    const otherLines = otherEntries.map((e) => ({
        _id: e._id,
        type: e.type,
        amount: round2(e.amount),
        referenceLabel: e.referenceLabel,
        date: e.date,
        paymentMethod: e.paymentMethod,
        note: e.note,
        isEdited: false
    }));
    let balance = round2(entries.reduce((sum, e) => sum + (e.amount || 0), 0));
    const customerBalance = round2(Number(customer.balance) || 0);
    const hasOpeningInLedger = entries.some((e) => e.type === 'opening_balance');
    const noDateFilter = !from && !to;
    let lines = [...saleLines, ...otherLines];
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    // When no date filter, no ledger entries exist, and the customer has an imported balance:
    // backfill an opening_balance ledger entry so the statement reflects it.
    // Only do this when entries.length === 0 — otherwise customer.balance already reflects
    // the existing transactions and creating an opening would double-count them.
    if (noDateFilter && customerBalance !== 0 && entries.length === 0) {
        try {
            await LedgerEntry.create({
                accountType: 'customer',
                accountId: customerId,
                accountModel: 'Customer',
                type: 'opening_balance',
                amount: customerBalance,
                referenceLabel: 'Balance brought forward',
                date: startOfToday,
                createdBy: req.user?.id
            });
        } catch (err) {
            // ignore duplicate or validation errors
        }
        balance = customerBalance;
        lines = [
            { _id: 'opening', type: 'opening_balance', amount: customerBalance, referenceLabel: 'Balance brought forward', date: startOfToday, paymentMethod: undefined, note: undefined, isEdited: false },
            ...lines
        ];
    }
    lines.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({
        success: true,
        data: {
            customer: { _id: customer._id, name: customer.name },
            balance,
            lines
        }
    });
});

// @desc    Record payment against a purchase (supplier)
// @route   POST /api/accounts/purchase/:id/pay
// @access  Private
exports.recordPurchasePayment = asyncHandler(async (req, res) => {
    const purchaseId = req.params.id;
    const { amount, paymentMethod, note, date } = req.body;
    if (amount == null || Number(amount) <= 0) {
        return res.status(400).json({
            success: false,
            message: 'A positive amount is required'
        });
    }
    const payAmount = round2(Number(amount));
    const tenantId = getTenantIdFromReq(req);
    const purchase = await Purchase.findOne({ _id: purchaseId, tenantId }).populate('account').populate('supplier');
    if (!purchase) {
        return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    const supplierId = purchase.supplier?._id || purchase.account?._id;
    const accountModel = purchase.accountModel || 'Supplier';
    if (!supplierId) {
        return res.status(400).json({
            success: false,
            message: 'Purchase has no supplier/account'
        });
    }
    const paidBefore = round2(Number(purchase.paid) || 0);
    const grandTotal = round2(Number(purchase.grandTotal) || 0);
    const unpaid = round2(grandTotal - paidBefore);
    if (payAmount > unpaid) {
        return res.status(400).json({
            success: false,
            message: `Payment (${payAmount.toFixed(2)}) exceeds unpaid amount (${unpaid.toFixed(2)})`
        });
    }
    const entry = await LedgerEntry.create({
        accountType: 'supplier',
        accountId: supplierId,
        accountModel,
        type: 'payment_out',
        amount: round2(-payAmount),
        referenceId: purchase._id,
        referenceLabel: purchase.purchaseNumber || `Purchase ${purchaseId}`,
        date: date ? new Date(date) : new Date(),
        paymentMethod: paymentMethod || 'cash',
        note: note || '',
        createdBy: req.user?.id
    });
    purchase.paid = round2(paidBefore + payAmount);
    purchase.paymentStatus = purchase.paid >= grandTotal ? 'Paid' : 'Partial';
    await purchase.save();
    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'Payment', entry._id, 'PAYMENT', { after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADDED',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Purchase payment ${payAmount.toFixed(2)} (${paymentMethod || 'cash'})`,
        amount: payAmount,
        paymentMethod: paymentMethod || 'cash',
        metaJson: { accountType: 'supplier', accountId: String(supplierId), purchaseId: String(purchaseId) },
        afterJson: entry.toObject()
    });

    res.status(200).json({
        success: true,
        message: 'Payment recorded',
        data: {
            purchaseId,
            paid: purchase.paid,
            paymentStatus: purchase.paymentStatus
        }
    });
});

// @desc    Record a general payment to a supplier (reduces supplier balance / amount payable).
//          Not tied to a specific purchase — for ad-hoc/lump-sum settlements from the
//          account statement screen.
// @route   POST /api/accounts/supplier-payment
// @access  Private
exports.recordSupplierPayment = asyncHandler(async (req, res) => {
    const { supplierId, amount, paymentMethod, note, date } = req.body;
    if (!supplierId || amount == null || Number(amount) <= 0) {
        return res.status(400).json({
            success: false,
            message: 'supplierId and a positive amount are required'
        });
    }
    const payAmount = round2(Number(amount));
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    // Source of truth = sum of live ledger entries (matches statement page).
    const ledgerEntries = await LedgerEntry.find({
        accountType: 'supplier',
        accountId: supplierId,
        deletedAt: null
    }).select('amount').lean();
    const currentBalance = round2(ledgerEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
    if (payAmount > currentBalance) {
        return res.status(400).json({
            success: false,
            message: `Payment (${payAmount.toFixed(2)}) exceeds amount payable (${currentBalance.toFixed(2)})`
        });
    }
    const entry = await LedgerEntry.create({
        accountType: 'supplier',
        accountId: supplierId,
        accountModel: 'Supplier',
        type: 'payment_out',
        amount: round2(-payAmount),
        referenceLabel: `Payment ${paymentMethod || 'cash'}`,
        date: date ? new Date(date) : new Date(),
        paymentMethod: paymentMethod || 'cash',
        note: note || '',
        createdBy: req.user?.id
    });
    redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
    await auditService.logFromReq(req, 'Payment', entry._id, 'PAYMENT', { after: entry.toObject() });
    await activityLogService.logFromReq(req, {
        action: 'PAYMENT_ADDED',
        entityType: 'LedgerEntry',
        entityId: entry._id,
        success: true,
        message: `Supplier payment ${payAmount.toFixed(2)} (${paymentMethod || 'cash'})`,
        amount: payAmount,
        paymentMethod: paymentMethod || 'cash',
        metaJson: { accountType: 'supplier', accountId: String(supplierId) },
        afterJson: entry.toObject()
    });
    res.status(201).json({
        success: true,
        message: 'Payment recorded',
        data: { balance: round2(currentBalance - payAmount) }
    });
});

// @desc    Get supplier account statement
// @route   GET /api/accounts/supplier/:id/statement
// @access  Private
exports.getSupplierStatement = asyncHandler(async (req, res) => {
    const supplierId = req.params.id;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const match = { accountType: 'supplier', accountId: supplierId, deletedAt: null };
    if (from && to) match.date = { $gte: from, $lte: to };
    else if (from) match.date = { $gte: from };
    else if (to) match.date = { $lte: to };

    // Run supplier lookup and ledger query in parallel
    const [supplier, entries] = await Promise.all([
        Supplier.findById(supplierId).select('name contactPerson').lean(),
        LedgerEntry.find(match).sort({ date: -1 }).lean()
    ]);

    if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    const lines = entries.map((e) => ({
        _id: e._id,
        type: e.type,
        amount: round2(e.amount),
        referenceLabel: e.referenceLabel,
        referenceId: e.referenceId,
        date: e.date,
        paymentMethod: e.paymentMethod,
        note: e.note
    }));

    const balance = round2(entries.reduce((sum, e) => sum + (e.amount || 0), 0));

    res.status(200).json({
        success: true,
        data: {
            supplier: {
                _id: supplier._id,
                name: supplier.name,
                contactPerson: supplier.contactPerson || '',
                displayLabel: formatSupplierLabel(supplier),
            },
            balance,
            lines
        }
    });
});

// @desc    Balance sheet summary: receivables, payables, optional by payment method
// @route   GET /api/accounts/balance-sheet
// @access  Private
exports.getBalanceSheet = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const cacheParams = { kind: 'balanceSheet', asOf: req.query.asOf || null };
    const payload = await cache.cached(
        { ns: 'accounts:list', tenantId, params: cacheParams, ttlSec: TTL.TRANSACTIONAL },
        async () => {

    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();

    const [customerSums, supplierSums, bankAccounts] = await Promise.all([
        LedgerEntry.aggregate([
            { $match: { accountType: 'customer', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        LedgerEntry.aggregate([
            { $match: { accountType: 'supplier', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        BankAccount.find({ isActive: true }).select('accountName bankName').lean()
    ]);

    const totalReceivables = round2((customerSums[0]?.total) || 0);
    const totalPayables = round2((supplierSums[0]?.total) || 0);

            return {
                asOf,
                receivables: totalReceivables,
                payables: totalPayables,
                bankAccounts: bankAccounts.map((b) => ({
                    _id: b._id,
                    accountName: b.accountName,
                    bankName: b.bankName
                }))
            };
        }
    );

    res.status(200).json({ success: true, data: payload });
});

// @desc    Debtors & creditors: all customer and supplier accounts with debit/credit
// @route   GET /api/accounts/debtors-creditors
// @access  Private
exports.getDebtorsCreditors = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const cacheParams = { kind: 'debtorsCreditors', asOf: req.query.asOf || null };
    const payload = await cache.cached(
        { ns: 'accounts:list', tenantId, params: cacheParams, ttlSec: TTL.TRANSACTIONAL },
        async () => {

    let asOf = new Date();
    if (req.query.asOf) {
        asOf = new Date(req.query.asOf);
        asOf.setUTCHours(23, 59, 59, 999);
    }

    const [customers, suppliers, customerBalances, supplierBalances] = await Promise.all([
        Customer.find({ tenantId }).select('_id name phone email balance').lean(),
        Supplier.find().select('_id name phone email contactPerson').lean(),
        LedgerEntry.aggregate([
            { $match: { accountType: 'customer', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: '$accountId', balance: { $sum: '$amount' } } }
        ]),
        LedgerEntry.aggregate([
            { $match: { accountType: 'supplier', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: '$accountId', balance: { $sum: '$amount' } } }
        ])
    ]);

    const balanceByCustomer = new Map(customerBalances.map((c) => [String(c._id), round2(c.balance)]));
    const balanceBySupplier = new Map(supplierBalances.map((s) => [String(s._id), round2(s.balance)]));

    const toRow = (acc, bal, fallbackBalance) => {
        const fromLedger = bal ?? 0;
        const balance = fromLedger !== 0 ? fromLedger : (round2(Number(fallbackBalance) || 0));
        return {
            accountId: acc._id,
            name: acc.name || '',
            phone: acc.phone || '',
            email: acc.email || '',
            debit: balance > 0 ? balance : 0,
            credit: balance < 0 ? -balance : 0
        };
    };

    const debtors = customers.map((c) => toRow(c, balanceByCustomer.get(String(c._id)), c.balance));
    const creditors = suppliers.map((s) => {
        const label = formatSupplierLabel(s);
        return toRow(
            label ? { ...s, name: label } : s,
            balanceBySupplier.get(String(s._id)),
            undefined
        );
    });

            return { asOf, debtors, creditors };
        }
    );

    res.status(200).json({ success: true, data: payload });
});

// @desc    Trial balance: list of customers and suppliers with balances
// @route   GET /api/accounts/trial-balance
// @access  Private
exports.getTrialBalance = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const cacheParams = { kind: 'trialBalance', asOf: req.query.asOf || null };
    const payload = await cache.cached(
        { ns: 'accounts:list', tenantId, params: cacheParams, ttlSec: TTL.TRANSACTIONAL },
        async () => {

    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();

    const [customerBalances, supplierBalances] = await Promise.all([
        LedgerEntry.aggregate([
            { $match: { accountType: 'customer', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: '$accountId', balance: { $sum: '$amount' } } },
            { $match: { balance: { $ne: 0 } } },
            { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'cust' } },
            { $unwind: { path: '$cust', preserveNullAndEmptyArrays: true } },
            { $project: { accountId: '$_id', name: '$cust.name', balance: 1, _id: 0 } }
        ]),
        LedgerEntry.aggregate([
            { $match: { accountType: 'supplier', date: { $lte: asOf }, deletedAt: null } },
            { $group: { _id: '$accountId', balance: { $sum: '$amount' } } },
            { $match: { balance: { $ne: 0 } } },
            { $lookup: { from: 'suppliers', localField: '_id', foreignField: '_id', as: 'sup' } },
            { $unwind: { path: '$sup', preserveNullAndEmptyArrays: true } },
            { $project: { accountId: '$_id', name: '$sup.name', contactPerson: '$sup.contactPerson', balance: 1, _id: 0 } }
        ])
    ]);

            return {
                asOf,
                customers: customerBalances.map((c) => ({ ...c, balance: round2(c.balance) })),
                suppliers: supplierBalances.map((s) => ({
                    accountId: s.accountId,
                    balance: round2(s.balance),
                    name: formatSupplierLabel(s) || s.name || '',
                }))
            };
        }
    );

    res.status(200).json({ success: true, data: payload });
});

// @desc    Profit and Loss: Revenue (sales) − Returns, COGS (sale lines), Gross Profit, Expenses, Net Profit
// @route   GET /api/accounts/profit-and-loss
// @access  Private
exports.getProfitAndLoss = asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), 0, 1);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const tid = getTenantIdFromReq(req);
    const locationIdParam = (req.query.locationId || 'all').trim().toLowerCase();
    const userScope = getUserLocationScope(req.user);

    if (userScope && userScope.length > 0) {
        if (!locationIdParam || locationIdParam === 'all') {
            return res.status(400).json({
                success: false,
                message: 'locationId is required for users assigned to specific locations',
            });
        }
        if (!userScope.some((id) => id === locationIdParam)) {
            return res.status(403).json({ success: false, message: 'Not allowed to view this location' });
        }
    } else if (locationIdParam !== 'all' && locationIdParam) {
        // Admin / unrestricted user with a specific location — no extra scope check.
    }

    const saleDateMatch = {
        tenantId: tid,
        $and: [
            { status: { $ne: 'voided' } },
            {
                $or: [
                    { occurredAt: { $gte: from, $lte: to } },
                    { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { createdAt: { $gte: from, $lte: to } }] }
                ]
            }
        ]
    };
    const returnDateMatch = {
        tenantId: tid,
        $or: [
            { occurredAt: { $gte: from, $lte: to } },
            { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { date: { $gte: from, $lte: to } }] },
            { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { date: { $exists: false } }, { createdAt: { $gte: from, $lte: to } }] }
        ]
    };

    if (locationIdParam !== 'all' && locationIdParam) {
        const locationObjectId = new mongoose.Types.ObjectId(locationIdParam);
        saleDateMatch.locationId = locationObjectId;
        returnDateMatch.locationId = locationObjectId;
    }

    const expenseDateMatch = {
        tenantId: tid,
        status: { $in: ['Approved', 'Paid'] },
        occurredAtUtc: { $gte: from, $lte: to },
    };

    const [
        revenueResult,
        cogsResult,
        returnRevenueResult,
        returnCogsResult,
        topProductsResult,
        expenseTotalResult,
        expenseByCategoryResult,
        missingCostLinesResult,
        missingCostSalesResult
    ] = await Promise.all([
        Sale.aggregate([
            { $match: saleDateMatch },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]),
        Sale.aggregate([
            { $match: saleDateMatch },
            { $unwind: '$items' },
            {
                $group: {
                    _id: null,
                    cogs: {
                        $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] }
                    }
                }
            }
        ]),
        SalesReturn.aggregate([
            { $match: returnDateMatch },
            { $group: { _id: null, total: { $sum: '$grandTotal' } } }
        ]),
        SalesReturn.aggregate([
            { $match: returnDateMatch },
            { $unwind: '$items' },
            {
                $group: {
                    _id: null,
                    cogs: {
                        $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_return', 0] }] }
                    }
                }
            }
        ]),
        Sale.aggregate([
            { $match: saleDateMatch },
            { $unwind: '$items' },
            {
                $project: {
                    sku: '$items.sku',
                    name: '$items.name',
                    lineRevenue: { $multiply: ['$items.price', '$items.quantity'] },
                    lineCogs: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] }
                }
            },
            {
                $group: {
                    _id: '$sku',
                    name: { $first: '$name' },
                    revenue: { $sum: '$lineRevenue' },
                    cogs: { $sum: '$lineCogs' }
                }
            },
            { $addFields: { grossProfit: { $subtract: ['$revenue', '$cogs'] } } },
            { $sort: { grossProfit: -1 } },
            { $limit: 20 },
            {
                $project: {
                    sku: '$_id',
                    name: 1,
                    revenue: { $round: ['$revenue', 2] },
                    cogs: { $round: ['$cogs', 2] },
                    grossProfit: { $round: ['$grossProfit', 2] },
                    _id: 0
                }
            }
        ]),
        Expense.aggregate([
            { $match: expenseDateMatch },
            { $group: { _id: null, total: { $sum: '$amountGross' } } }
        ]),
        Expense.aggregate([
            { $match: expenseDateMatch },
            { $group: { _id: '$categoryId', totalGross: { $sum: '$amountGross' }, count: { $sum: 1 } } },
            { $lookup: { from: 'expense_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
            { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
            { $project: { categoryName: '$cat.name', totalGross: 1, count: 1, _id: 1 } }
        ]),
        Sale.aggregate([
            { $match: saleDateMatch },
            { $unwind: '$items' },
            {
                $match: {
                    type: { $ne: 'repair' },
                    'items.quantity': { $gt: 0 },
                    $or: [
                        { 'items.unit_cost_at_sale': { $exists: false } },
                        { 'items.unit_cost_at_sale': null },
                        { 'items.unit_cost_at_sale': 0 }
                    ]
                }
            },
            { $group: { _id: null, count: { $sum: 1 } } }
        ]),
        Sale.aggregate([
            { $match: saleDateMatch },
            { $unwind: '$items' },
            {
                $match: {
                    type: { $ne: 'repair' },
                    'items.quantity': { $gt: 0 },
                    $or: [
                        { 'items.unit_cost_at_sale': { $exists: false } },
                        { 'items.unit_cost_at_sale': null },
                        { 'items.unit_cost_at_sale': 0 }
                    ]
                }
            },
            { $group: { _id: '$_id' } },
            { $count: 'count' }
        ])
    ]);

    const salesRevenue = round2((revenueResult[0]?.total) || 0);
    const returnRevenue = round2((returnRevenueResult[0]?.total) || 0);
    const revenue = round2(salesRevenue - returnRevenue);

    const cogsSales = round2((cogsResult[0]?.cogs) || 0);
    const cogsReturnReversal = round2((returnCogsResult[0]?.cogs) || 0);
    const cogs = round2(cogsSales - cogsReturnReversal);

    const grossProfit = round2(revenue - cogs);
    const totalExpenses = round2((expenseTotalResult[0]?.total) || 0);
    const netProfit = round2(grossProfit - totalExpenses);

    const topProductsByGrossProfit = (topProductsResult || []).map((row) => ({
        sku: row.sku || '',
        name: row.name || '',
        revenue: round2(row.revenue || 0),
        cogs: round2(row.cogs || 0),
        grossProfit: round2(row.grossProfit != null ? row.grossProfit : (row.revenue || 0) - (row.cogs || 0))
    }));

    const expensesByCategory = (expenseByCategoryResult || []).map((row) => ({
        categoryId: row._id,
        categoryName: row.categoryName || 'Uncategorised',
        totalGross: round2(row.totalGross || 0),
        count: row.count || 0
    }));

    const missingCostLineCount = (missingCostLinesResult && missingCostLinesResult[0] && missingCostLinesResult[0].count) || 0;
    const missingCostSaleCount = (missingCostSalesResult && missingCostSalesResult[0] && missingCostSalesResult[0].count) || 0;

    let location = { locationId: 'all', name: 'All locations' };
    if (locationIdParam !== 'all' && locationIdParam) {
        const loc = await Location.findById(locationIdParam).select('name').lean();
        location = { locationId: locationIdParam, name: loc?.name || 'Unknown' };
    }

    res.status(200).json({
        success: true,
        data: {
            from,
            to,
            location,
            revenue,
            salesRevenue,
            returnRevenue,
            cogs,
            cogsSales,
            cogsReturnReversal,
            grossProfit,
            totalExpenses,
            netProfit,
            topProductsByGrossProfit,
            expensesByCategory,
            missingCostLineCount,
            missingCostSaleCount
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined customers + suppliers list for the create-sales account dropdown.
// Replaces two parallel calls (/customers + /suppliers) with one round-trip,
// minimal projection, and a 30-second per-tenant in-memory cache (accounts list
// rarely changes; mutated by add-customer / add-supplier flows that should call
// invalidateAccountsForSalesCache).
// ─────────────────────────────────────────────────────────────────────────────
const _accountsForSalesCache = new Map(); // tenantId → { body, ts }
const ACCOUNTS_FOR_SALES_TTL = 30_000;

function invalidateAccountsForSalesCache(tenantId) {
    if (tenantId) _accountsForSalesCache.delete(tenantId);
}
exports.invalidateAccountsForSalesCache = invalidateAccountsForSalesCache;

const CUSTOMER_PROJECTION = {
    _id: 1, name: 1, phone: 1, email: 1, mobile: 1, contactName: 1,
    isActive: 1, isWalkIn: 1, balance: 1, currency: 1, pricingGroupId: 1,
    address: 1, companyNumber: 1, vatNumber: 1, useInRepairs: 1
};
const SUPPLIER_PROJECTION = {
    _id: 1, name: 1, phone: 1, email: 1, mobile: 1, contactPerson: 1,
    isActive: 1, currency: 1, address: 1, companyNumber: 1, vatNumber: 1
};

// @desc    Combined accounts list (customers + suppliers) for create-sales dropdown.
//          Single round-trip; 30s per-tenant cache; minimal projection.
// @route   GET /api/accounts/for-sales
// @access  Private (sale.create)
exports.getAccountsForSales = asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const tenantId = getTenantIdFromReq(req) || 'default';

    // Skip cache when caller explicitly asks (?fresh=1).
    if (req.query.fresh !== '1') {
        const entry = _accountsForSalesCache.get(tenantId);
        if (entry && Date.now() - entry.ts < ACCOUNTS_FOR_SALES_TTL) {
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Server-Timing', `total;dur=${Date.now() - t0}`);
            return res.status(200).json(entry.body);
        }
    }

    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 1000));

    const [customers, suppliers] = await Promise.all([
        Customer.find({ tenantId, isActive: true }, CUSTOMER_PROJECTION)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean(),
        Supplier.find({ isActive: true }, SUPPLIER_PROJECTION)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean(),
    ]);

    // Round customer balances once on the server (frontend doesn't need to).
    for (const c of customers) {
        if (c.balance != null) c.balance = round2(c.balance);
    }

    const body = {
        success: true,
        tookMs: Date.now() - t0,
        customers,
        suppliers,
        counts: { customers: customers.length, suppliers: suppliers.length }
    };

    _accountsForSalesCache.set(tenantId, { body, ts: Date.now() });
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Server-Timing', `total;dur=${Date.now() - t0}`);
    res.status(200).json(body);
});
