const Expense = require('../models/Expense');
const ExpenseCategory = require('../models/ExpenseCategory');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const EXPENSE_CACHE_NAMESPACES = ['expenses:list', 'paymentAccounts:list'];
async function invalidateExpenseCaches(tenantId) {
    await cache.bumpMany(EXPENSE_CACHE_NAMESPACES, tenantId);
}

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function validateAmounts(amountNet, vatAmount, amountGross) {
    const net = round2(amountNet);
    const vat = round2(vatAmount);
    const gross = round2(amountGross);
    if (Math.abs(gross - (net + vat)) > 0.01) {
        return { valid: false, message: 'amount_gross must equal amount_net + vat_amount' };
    }
    return { valid: true, net, vat, gross };
}

exports.list = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const params = {
        page, limit,
        fromUtc: req.query.fromUtc || null,
        toUtc: req.query.toUtc || null,
        categoryId: req.query.categoryId || null,
        status: req.query.status || null,
        paymentMethod: req.query.paymentMethod || null,
        createdByUserId: req.query.createdByUserId || null,
        approvedByUserId: req.query.approvedByUserId || null,
        costCentre: req.query.costCentre || null,
        search: (req.query.search && req.query.search.trim()) || null
    };

    const payload = await cache.cached(
        { ns: 'expenses:list', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => {
            const filter = { tenantId };
            if (req.query.fromUtc) filter.occurredAtUtc = filter.occurredAtUtc || {};
            if (req.query.fromUtc) filter.occurredAtUtc.$gte = new Date(req.query.fromUtc);
            if (req.query.toUtc) filter.occurredAtUtc = filter.occurredAtUtc || {};
            if (req.query.toUtc) filter.occurredAtUtc.$lte = new Date(req.query.toUtc);
            if (req.query.categoryId) filter.categoryId = req.query.categoryId;
            if (req.query.status) filter.status = req.query.status;
            if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
            if (req.query.createdByUserId) filter.createdByUserId = req.query.createdByUserId;
            if (req.query.approvedByUserId) filter.approvedByUserId = req.query.approvedByUserId;
            if (req.query.costCentre) {
                const cats = await ExpenseCategory.find({ costCentre: req.query.costCentre }).select('_id').lean();
                filter.categoryId = { $in: cats.map((c) => c._id) };
            }
            if (req.query.search && req.query.search.trim()) {
                const q = req.query.search.trim();
                filter.$or = [
                    { paymentReference: new RegExp(q, 'i') },
                    { description: new RegExp(q, 'i') },
                    { notes: new RegExp(q, 'i') },
                    { vendorName: new RegExp(q, 'i') }
                ];
            }

            const [items, total] = await Promise.all([
                Expense.find(filter)
                    .populate('categoryId', 'name code costCentre')
                    .populate('createdByUserId', 'name')
                    .populate('approvedByUserId', 'name')
                    .sort({ occurredAtUtc: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                Expense.countDocuments(filter)
            ]);
            return { items, total };
        }
    );

    res.json({
        success: true,
        data: payload.items,
        pagination: { page, limit, total: payload.total, pages: Math.ceil(payload.total / limit) }
    });
});

exports.getById = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId })
        .populate('categoryId')
        .populate('createdByUserId', 'name')
        .populate('approvedByUserId', 'name')
        .lean();
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    res.json({ success: true, data: expense });
});

exports.create = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to create expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    if (req.body.tenantId !== undefined) delete req.body.tenantId;
    const body = { ...req.body, tenantId, status: 'Draft', createdByUserId: req.user._id };
    const validation = validateAmounts(body.amountNet, body.vatAmount, body.amountGross);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.message });
    }
    body.amountNet = validation.net;
    body.vatAmount = validation.vat;
    body.amountGross = validation.gross;

    const doc = await Expense.create(body);
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_CREATED',
        entityType: 'Expense',
        entityId: doc._id,
        success: true,
        message: `Expense created (Draft)`,
        amount: doc.amountGross,
        afterJson: doc.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to edit expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (!['Draft', 'Submitted'].includes(expense.status)) {
        return res.status(400).json({ success: false, message: 'Can only edit Draft or Submitted expenses' });
    }
    const before = expense.toObject();
    const allowed = ['occurredAtUtc', 'vendorId', 'vendorName', 'categoryId', 'description', 'notes', 'amountNet', 'vatAmount', 'amountGross', 'vatRate', 'paymentMethod', 'paymentReference', 'branchId', 'warehouseId', 'linkedEntityType', 'linkedEntityId', 'attachments'];
    for (const key of allowed) {
        if (req.body[key] !== undefined) expense[key] = req.body[key];
    }
    const validation = validateAmounts(expense.amountNet, expense.vatAmount, expense.amountGross);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.message });
    }
    expense.amountNet = validation.net;
    expense.vatAmount = validation.vat;
    expense.amountGross = validation.gross;
    await expense.save();

    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_UPDATED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: `Expense updated`,
        beforeJson: before,
        afterJson: expense.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.submit = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.submit')) {
        return res.status(403).json({ success: false, message: 'Not allowed to submit expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId }).populate('categoryId');
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (expense.status !== 'Draft') {
        return res.status(400).json({ success: false, message: 'Only Draft expenses can be submitted' });
    }
    if (expense.categoryId && expense.categoryId.requiresAttachment && (!expense.attachments || expense.attachments.length === 0)) {
        return res.status(400).json({ success: false, message: 'This category requires an attachment before submit' });
    }
    const before = expense.toObject();
    expense.status = 'Submitted';
    await expense.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_SUBMITTED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: 'Expense submitted',
        beforeJson: before,
        afterJson: expense.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.approve = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.approve')) {
        return res.status(403).json({ success: false, message: 'Not allowed to approve expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId }).populate('categoryId');
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (expense.status !== 'Submitted') {
        return res.status(400).json({ success: false, message: 'Only Submitted expenses can be approved' });
    }
    const before = expense.toObject();
    expense.status = 'Approved';
    expense.approvedByUserId = req.user._id;
    expense.approvedAtUtc = new Date();
    await expense.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_APPROVED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: 'Expense approved',
        beforeJson: before,
        afterJson: expense.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.reject = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.approve')) {
        return res.status(403).json({ success: false, message: 'Not allowed to reject expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (expense.status !== 'Submitted') {
        return res.status(400).json({ success: false, message: 'Only Submitted expenses can be rejected' });
    }
    const before = expense.toObject();
    expense.status = 'Rejected';
    expense.approvedByUserId = req.user._id;
    expense.approvedAtUtc = new Date();
    if (req.body.reason) expense.notes = (expense.notes || '') + '\nRejected: ' + req.body.reason;
    await expense.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_REJECTED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: 'Expense rejected',
        beforeJson: before,
        afterJson: expense.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.markPaid = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.mark_paid')) {
        return res.status(403).json({ success: false, message: 'Not allowed to mark expenses as paid' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (expense.status !== 'Approved') {
        return res.status(400).json({ success: false, message: 'Only Approved expenses can be marked paid' });
    }
    const before = expense.toObject();
    expense.status = 'Paid';
    await expense.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_PAID',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: 'Expense marked paid',
        beforeJson: before,
        afterJson: expense.toObject()
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.deleteExpense = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.delete') && !can(req.user, 'expense.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to delete expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const expense = await Expense.findOne({ _id: req.params.id, tenantId });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (!['Draft', 'Submitted'].includes(expense.status)) {
        return res.status(400).json({ success: false, message: 'Only Draft or Submitted expenses can be deleted' });
    }
    const before = expense.toObject();
    await Expense.findOneAndDelete({ _id: req.params.id, tenantId });
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_DELETED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: 'Expense deleted',
        beforeJson: before
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, message: 'Expense deleted' });
});

exports.voidExpense = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.void')) {
        return res.status(403).json({ success: false, message: 'Not allowed to void expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const reason = (req.body.voidReason || '').trim();
    if (!reason) {
        return res.status(400).json({ success: false, message: 'voidReason is required' });
    }
    const expense = await Expense.findOne({ _id: req.params.id, tenantId });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    if (expense.status === 'Voided') {
        return res.status(400).json({ success: false, message: 'Expense is already voided' });
    }
    const before = expense.toObject();
    expense.status = 'Voided';
    expense.voidReason = reason;
    await expense.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_VOIDED',
        entityType: 'Expense',
        entityId: expense._id,
        success: true,
        message: `Expense voided: ${reason}`,
        beforeJson: before,
        afterJson: expense.toObject(),
        metaJson: { voidReason: reason }
    });
    await invalidateExpenseCaches(tenantId);
    res.json({ success: true, data: expense });
});

exports.reportTotals = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view expenses' });
    }
    const tenantId = getTenantIdFromReq(req);
    const fromUtc = req.query.fromUtc ? new Date(req.query.fromUtc) : null;
    const toUtc = req.query.toUtc ? new Date(req.query.toUtc) : null;
    const match = { tenantId };
    if (fromUtc) match.occurredAtUtc = match.occurredAtUtc || {};
    if (fromUtc) match.occurredAtUtc.$gte = fromUtc;
    if (toUtc) match.occurredAtUtc = match.occurredAtUtc || {};
    if (toUtc) match.occurredAtUtc.$lte = toUtc;
    match.status = { $in: ['Approved', 'Paid'] };

    const byCategory = await Expense.aggregate([
        { $match: match },
        { $group: { _id: '$categoryId', totalGross: { $sum: '$amountGross' }, totalVat: { $sum: '$vatAmount' }, count: { $sum: 1 } } },
        { $lookup: { from: 'expense_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
        { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
        { $project: { categoryName: '$cat.name', costCentre: '$cat.costCentre', totalGross: 1, totalVat: 1, count: 1 } }
    ]);

    const byCostCentre = await Expense.aggregate([
        { $match: match },
        { $lookup: { from: 'expense_categories', localField: 'categoryId', foreignField: '_id', as: 'cat' } },
        { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
        { $group: { _id: '$cat.costCentre', totalGross: { $sum: '$amountGross' }, totalVat: { $sum: '$vatAmount' }, count: { $sum: 1 } } }
    ]);

    const vatSummary = await Expense.aggregate([
        { $match: match },
        { $group: { _id: null, totalVat: { $sum: '$vatAmount' } } }
    ]);

    res.json({
        success: true,
        data: {
            byCategory,
            byCostCentre,
            totalInputVat: vatSummary[0] ? vatSummary[0].totalVat : 0
        }
    });
});
