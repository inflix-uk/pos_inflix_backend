const GeneralSettings = require('../models/GeneralSettings');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const mongoose = require('mongoose');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const GENERAL_SETTINGS_NS = 'settings:general';
async function invalidateGeneralSettingsCache(tenantId) {
    await cache.bumpNs(GENERAL_SETTINGS_NS, tenantId);
}

/**
 * Find an active account (Customer or Supplier) by id. Returns { doc, type: 'Customer'|'Supplier' } or null.
 */
async function findActiveAccountById(id) {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
    const customer = await Customer.findOne({ _id: id, isActive: true }).select('_id name').lean();
    if (customer) return { doc: customer, type: 'Customer' };
    const supplier = await Supplier.findOne({ _id: id, isActive: true }).select('_id name').lean();
    if (supplier) return { doc: supplier, type: 'Supplier' };
    return null;
}

// @desc    Get general settings (including sales auto-select)
// @route   GET /api/settings/general
// @access  Private (settings.view)
exports.getGeneralSettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const data = await cache.cached(
        { ns: GENERAL_SETTINGS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => {
            const settings = await GeneralSettings.getSettings();
            const out = {
                salesAutoSelectAccountEnabled: !!settings.salesAutoSelectAccountEnabled,
                defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null,
                retailModeEnabled: !!settings.retailModeEnabled,
                updatedAtUtc: settings.updatedAt
            };
            if (settings.defaultSalesAccountId) {
                const account = await findActiveAccountById(settings.defaultSalesAccountId);
                if (account) {
                    out.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
                }
            }
            return out;
        }
    );
    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Update sales auto-select account settings
// @route   PUT /api/settings/general/sales-auto-select-account
// @access  Private (settings.manage)
exports.updateSalesAutoSelectAccount = asyncHandler(async (req, res) => {
    const { enabled, defaultSalesAccountId: rawId } = req.body;

    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };

    if (typeof enabled === 'boolean') {
        settings.salesAutoSelectAccountEnabled = enabled;
    }

    if (rawId !== undefined) {
        if (rawId === null || rawId === '') {
            settings.defaultSalesAccountId = null;
        } else {
            const id = typeof rawId === 'string' ? rawId.trim() : String(rawId);
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ success: false, message: 'Invalid defaultSalesAccountId' });
            }
            const account = await findActiveAccountById(id);
            if (!account) {
                return res.status(400).json({ success: false, message: 'Account not found or inactive' });
            }
            settings.defaultSalesAccountId = account.doc._id;
        }
    }

    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();

    const after = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };

    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-sales-auto-select',
        success: true,
        message: 'Sales auto-select account settings updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));

    const responseData = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };
    if (settings.defaultSalesAccountId) {
        const account = await findActiveAccountById(settings.defaultSalesAccountId);
        if (account) {
            responseData.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
        }
    }
    res.status(200).json({
        success: true,
        message: 'Settings updated',
        data: responseData
    });
});

// @desc    Update sales mode (retail vs wholesale)
// @route   PUT /api/settings/general/sales-mode
// @access  Private (settings.manage)
exports.updateSalesMode = asyncHandler(async (req, res) => {
    const { retailModeEnabled } = req.body;
    if (typeof retailModeEnabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'retailModeEnabled must be a boolean' });
    }
    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = { retailModeEnabled: !!settings.retailModeEnabled };
    settings.retailModeEnabled = retailModeEnabled;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    const after = { retailModeEnabled: !!settings.retailModeEnabled };
    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-sales-mode',
        success: true,
        message: 'Sales mode updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));
    const data = {
        salesAutoSelectAccountEnabled: !!settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null,
        retailModeEnabled: !!settings.retailModeEnabled,
        updatedAtUtc: settings.updatedAt
    };
    if (settings.defaultSalesAccountId) {
        const account = await findActiveAccountById(settings.defaultSalesAccountId);
        if (account) {
            data.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
        }
    }
    res.status(200).json({
        success: true,
        message: 'Settings updated',
        data
    });
});
