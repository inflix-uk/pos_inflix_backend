const InventorySettings = require('../models/InventorySettings');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const INVENTORY_SETTINGS_NS = 'settings:inventory';
async function invalidateInventorySettingsCache(tenantId) {
    await cache.bumpNs(INVENTORY_SETTINGS_NS, tenantId);
}

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

// @desc    Get inventory settings
// @route   GET /api/settings/inventory
// @access  Private (settings.view or inventory.settings.manage)
exports.getInventorySettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const settings = await cache.cached(
        { ns: INVENTORY_SETTINGS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => await InventorySettings.getSettings()
    );
    res.status(200).json({
        success: true,
        data: settings
    });
});

// @desc    Update inventory settings (including defaultLowStockThreshold)
// @route   PUT /api/settings/inventory
// @access  Private (settings.edit or inventory.settings.manage)
exports.updateInventorySettings = asyncHandler(async (req, res) => {
    let settings = await InventorySettings.findOne();
    if (!settings) {
        settings = await InventorySettings.create({});
    }
    const before = {
        defaultLowStockThreshold: settings.defaultLowStockThreshold,
        syncSalePriceToSameVariant: settings.syncSalePriceToSameVariant,
        syncAllLocations: settings.syncAllLocations
    };
    if (typeof req.body.syncSalePriceToSameVariant === 'boolean') {
        settings.syncSalePriceToSameVariant = req.body.syncSalePriceToSameVariant;
    }
    if (typeof req.body.syncAllLocations === 'boolean') {
        settings.syncAllLocations = req.body.syncAllLocations;
    }
    if (req.body.defaultLowStockThreshold !== undefined) {
        if (!can(req.user, 'settings.edit') && !can(req.user, 'inventory.settings.manage') && !can(req.user, 'product.edit')) {
            return res.status(403).json({ success: false, message: 'Not allowed to update default low stock threshold' });
        }
        const v = parseInt(req.body.defaultLowStockThreshold, 10);
        if (isNaN(v) || v < 0) {
            return res.status(400).json({ success: false, message: 'defaultLowStockThreshold must be a non-negative number' });
        }
        settings.defaultLowStockThreshold = v;
    }
    await settings.save();
    if (before.defaultLowStockThreshold !== settings.defaultLowStockThreshold) {
        await activityLogService.logFromReq(req, {
            action: 'LOW_STOCK_THRESHOLD_GLOBAL_UPDATED',
            entityType: 'Inventory',
            entityId: 'settings',
            success: true,
            message: `Default low stock threshold changed to ${settings.defaultLowStockThreshold}`,
            diffJson: { old: before.defaultLowStockThreshold, new: settings.defaultLowStockThreshold }
        });
    }
    if (before.syncAllLocations !== settings.syncAllLocations) {
        await activityLogService.logFromReq(req, {
            action: 'SYNC_ALL_LOCATIONS_UPDATED',
            entityType: 'Inventory',
            entityId: 'settings',
            success: true,
            message: `Create Sales inventory sync across all locations ${settings.syncAllLocations ? 'enabled' : 'disabled'}`,
            diffJson: { old: before.syncAllLocations, new: settings.syncAllLocations }
        });
    }
    await invalidateInventorySettingsCache(getTenantIdFromReq(req));
    res.status(200).json({
        success: true,
        message: 'Inventory settings updated',
        data: settings
    });
});
