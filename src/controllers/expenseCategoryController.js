const ExpenseCategory = require('../models/ExpenseCategory');
const Expense = require('../models/Expense');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const EXPENSE_CATEGORY_CACHE_NAMESPACES = ['expenseCategories:list', 'expenses:list'];
async function invalidateExpenseCategoryCaches(tenantId) {
    await cache.bumpMany(EXPENSE_CATEGORY_CACHE_NAMESPACES, tenantId);
}

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

exports.getCategories = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view expense categories' });
    }
    const tenantId = getTenantIdFromReq(req);
    const includeInactive = req.query.includeInactive === 'true';
    const params = { includeInactive };
    const list = await cache.cached(
        { ns: 'expenseCategories:list', tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = includeInactive ? {} : { isActive: true };
            return await ExpenseCategory.find(query).populate('parentCategoryId', 'name code').sort({ name: 1 }).lean();
        }
    );
    res.json({ success: true, data: list });
});

exports.getCategoryById = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view expense categories' });
    }
    const cat = await ExpenseCategory.findById(req.params.id).populate('parentCategoryId', 'name code').lean();
    if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: cat });
});

exports.createCategory = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.manage')) {
        return res.status(403).json({ success: false, message: 'Not allowed to manage expense categories' });
    }
    const doc = await ExpenseCategory.create(req.body);
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_CATEGORY_CREATED',
        entityType: 'ExpenseCategory',
        entityId: doc._id,
        success: true,
        message: `Expense category created: ${doc.name}`,
        afterJson: doc.toObject()
    });
    await invalidateExpenseCategoryCaches(getTenantIdFromReq(req));
    res.status(201).json({ success: true, data: doc });
});

exports.updateCategory = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.manage')) {
        return res.status(403).json({ success: false, message: 'Not allowed to manage expense categories' });
    }
    const before = await ExpenseCategory.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Category not found' });
    const updated = await ExpenseCategory.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
    ).lean();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_CATEGORY_UPDATED',
        entityType: 'ExpenseCategory',
        entityId: updated._id,
        success: true,
        message: `Expense category updated: ${updated.name}`,
        beforeJson: before.toObject(),
        afterJson: updated
    });
    await invalidateExpenseCategoryCaches(getTenantIdFromReq(req));
    res.json({ success: true, data: updated });
});

exports.archiveCategory = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.manage')) {
        return res.status(403).json({ success: false, message: 'Not allowed to manage expense categories' });
    }
    const cat = await ExpenseCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
    const inUse = await Expense.countDocuments({ categoryId: cat._id });
    if (inUse > 0) {
        return res.status(400).json({
            success: false,
            message: `Cannot archive: category is used by ${inUse} expense(s). Use inactive instead or reassign expenses.`
        });
    }
    const before = cat.toObject();
    cat.isActive = false;
    await cat.save();
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_CATEGORY_ARCHIVED',
        entityType: 'ExpenseCategory',
        entityId: cat._id,
        success: true,
        message: `Expense category archived: ${cat.name}`,
        beforeJson: before,
        afterJson: cat.toObject()
    });
    await invalidateExpenseCategoryCaches(getTenantIdFromReq(req));
    res.json({ success: true, data: cat });
});

exports.setInactive = asyncHandler(async (req, res) => {
    if (!can(req.user, 'expense_category.manage')) {
        return res.status(403).json({ success: false, message: 'Not allowed to manage expense categories' });
    }
    const cat = await ExpenseCategory.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { new: true, runValidators: true }
    ).lean();
    if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
    await activityLogService.logFromReq(req, {
        action: 'EXPENSE_CATEGORY_UPDATED',
        entityType: 'ExpenseCategory',
        entityId: cat._id,
        success: true,
        message: `Expense category set inactive: ${cat.name}`,
        afterJson: cat
    });
    await invalidateExpenseCategoryCaches(getTenantIdFromReq(req));
    res.json({ success: true, data: cat });
});
