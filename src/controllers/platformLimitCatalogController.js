const LimitCatalog = require('../models/LimitCatalog');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const PLATFORM_LIMITS_NS = 'platform:limits';
const /* deprecated */ PLATFORM_SCOPE = 'global';
async function invalidatePlatformLimitsCache(tenantId) { await cache.bumpNs(PLATFORM_LIMITS_NS, tenantId); }

exports.list = asyncHandler(async (req, res) => {
    const activeOnly = req.query.active !== 'false';
    const items = await cache.cached(
        { ns: PLATFORM_LIMITS_NS, tenantId: getTenantIdFromReq(req), params: { activeOnly }, ttlSec: TTL.REFERENCE },
        async () => {
            const query = activeOnly ? { isActive: true } : {};
            return await LimitCatalog.find(query).sort({ key: 1 }).lean();
        }
    );
    res.status(200).json({ success: true, data: items });
});

exports.create = asyncHandler(async (req, res) => {
    const { key, name, description, unit, defaultValue, isActive } = req.body;
    const existing = await LimitCatalog.findOne({ key: (key || '').trim().toLowerCase() });
    if (existing) {
        return res.status(400).json({ success: false, message: 'Limit key already exists' });
    }
    const doc = await LimitCatalog.create({
        key: (key || '').trim().toLowerCase(),
        name: (name || '').trim(),
        description: (description || '').trim(),
        unit: (unit || 'count').trim(),
        defaultValue: defaultValue != null ? Number(defaultValue) : null,
        isActive: isActive !== false
    });
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_LIMIT_CATALOG_CREATED',
        entityType: 'LimitCatalog',
        entityId: doc._id,
        success: true,
        message: `Limit ${doc.key} created`,
        afterJson: doc.toObject ? doc.toObject() : doc
    });
    await invalidatePlatformLimitsCache(getTenantIdFromReq(req));
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    const doc = await LimitCatalog.findOne({ key: req.params.key });
    if (!doc) return res.status(404).json({ success: false, message: 'Limit not found' });
    const before = doc.toObject();
    const { name, description, unit, defaultValue, isActive } = req.body;
    if (name !== undefined) doc.name = name.trim();
    if (description !== undefined) doc.description = description.trim();
    if (unit !== undefined) doc.unit = unit.trim();
    if (defaultValue !== undefined) doc.defaultValue = defaultValue != null ? Number(defaultValue) : null;
    if (isActive !== undefined) doc.isActive = !!isActive;
    await doc.save();
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_LIMIT_CATALOG_UPDATED',
        entityType: 'LimitCatalog',
        entityId: doc._id,
        success: true,
        message: `Limit ${doc.key} updated`,
        beforeJson: before,
        afterJson: doc.toObject()
    });
    await invalidatePlatformLimitsCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: doc });
});
