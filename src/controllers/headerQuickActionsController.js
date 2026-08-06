const HeaderQuickActionsSettings = require('../models/HeaderQuickActionsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const HEADER_QUICK_ACTIONS_NS = 'settings:headerQuickActions';
async function invalidateHeaderQuickActionsCache(tenantId) {
    await cache.bumpNs(HEADER_QUICK_ACTIONS_NS, tenantId);
}

const FIELDS = ['showNewSale', 'showNewRepair', 'showParcel', 'showReturn', 'showSalesModeToggle', 'showAccounts', 'showStockList', 'showSalesOnline', 'showNewInvoice', 'showNotebooks'];
/** Defaults when a field is unset (most on; Invoice off until enabled in settings). */
const FIELD_DEFAULTS = {
    showNewSale: true,
    showNewRepair: true,
    showParcel: true,
    showReturn: true,
    showSalesModeToggle: true,
    showAccounts: true,
    showStockList: true,
    showSalesOnline: true,
    showNewInvoice: false,
    showNotebooks: true,
};

function fieldVisible(settings, f) {
    if (typeof settings[f] === 'boolean') return settings[f];
    return FIELD_DEFAULTS[f] !== false;
}

// @desc    Get header quick actions visibility
// @route   GET /api/settings/header-quick-actions
// @access  Private (settings.view)
exports.getHeaderQuickActions = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const data = await cache.cached(
        { ns: HEADER_QUICK_ACTIONS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => {
            const settings = await HeaderQuickActionsSettings.getSettings();
            const out = {};
            for (const f of FIELDS) {
                out[f] = fieldVisible(settings, f);
            }
            return out;
        }
    );
    res.status(200).json({ success: true, data });
});

// @desc    Update header quick actions visibility
// @route   PUT /api/settings/header-quick-actions
// @access  Private (settings.manage)
exports.updateHeaderQuickActions = asyncHandler(async (req, res) => {
    let settings = await HeaderQuickActionsSettings.findOne();
    if (!settings) {
        settings = await HeaderQuickActionsSettings.create({});
    }

    for (const f of FIELDS) {
        if (typeof req.body[f] === 'boolean') {
            settings[f] = req.body[f];
        }
    }

    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    await invalidateHeaderQuickActionsCache(getTenantIdFromReq(req));

    const data = {};
    for (const f of FIELDS) {
        data[f] = fieldVisible(settings, f);
    }
    res.status(200).json({ success: true, data });
});
