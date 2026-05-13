const HeaderQuickActionsSettings = require('../models/HeaderQuickActionsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const HEADER_QUICK_ACTIONS_NS = 'settings:headerQuickActions';
async function invalidateHeaderQuickActionsCache(tenantId) {
    await cache.bumpNs(HEADER_QUICK_ACTIONS_NS, tenantId);
}

const FIELDS = ['showNewSale', 'showNewRepair', 'showParcel', 'showReturn', 'showSalesModeToggle', 'showAccounts', 'showStockList'];

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
                out[f] = settings[f] !== false;
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
        data[f] = settings[f] !== false;
    }
    res.status(200).json({ success: true, data });
});
