const FeatureCatalog = require('../models/FeatureCatalog');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const PLATFORM_FEATURES_NS = 'platform:features';
const /* deprecated */ PLATFORM_SCOPE = 'global';
async function invalidatePlatformFeaturesCache(tenantId) { await cache.bumpNs(PLATFORM_FEATURES_NS, tenantId); }

exports.list = asyncHandler(async (req, res) => {
    const activeOnly = req.query.active !== 'false';
    const items = await cache.cached(
        { ns: PLATFORM_FEATURES_NS, tenantId: getTenantIdFromReq(req), params: { activeOnly }, ttlSec: TTL.REFERENCE },
        async () => {
            const query = activeOnly ? { isActive: true } : {};
            return await FeatureCatalog.find(query).sort({ category: 1, key: 1 }).lean();
        }
    );
    res.status(200).json({ success: true, data: items });
});

exports.create = asyncHandler(async (req, res) => {
    const { key, name, description, category, defaultEnabled, isActive } = req.body;
    const existing = await FeatureCatalog.findOne({ key: (key || '').trim().toLowerCase() });
    if (existing) {
        return res.status(400).json({ success: false, message: 'Feature key already exists' });
    }
    const doc = await FeatureCatalog.create({
        key: (key || '').trim().toLowerCase(),
        name: (name || '').trim(),
        description: (description || '').trim(),
        category: (category || 'Core').trim(),
        defaultEnabled: defaultEnabled === true,
        isActive: isActive !== false
    });
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_FEATURE_CATALOG_CREATED',
        entityType: 'FeatureCatalog',
        entityId: doc._id,
        success: true,
        message: `Feature ${doc.key} created`,
        afterJson: doc.toObject ? doc.toObject() : doc
    });
    await invalidatePlatformFeaturesCache(getTenantIdFromReq(req));
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    const doc = await FeatureCatalog.findOne({ key: req.params.key });
    if (!doc) return res.status(404).json({ success: false, message: 'Feature not found' });
    const before = doc.toObject();
    const { name, description, category, defaultEnabled, isActive } = req.body;
    if (name !== undefined) doc.name = name.trim();
    if (description !== undefined) doc.description = description.trim();
    if (category !== undefined) doc.category = category.trim();
    if (defaultEnabled !== undefined) doc.defaultEnabled = !!defaultEnabled;
    if (isActive !== undefined) doc.isActive = !!isActive;
    await doc.save();
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_FEATURE_CATALOG_UPDATED',
        entityType: 'FeatureCatalog',
        entityId: doc._id,
        success: true,
        message: `Feature ${doc.key} updated`,
        beforeJson: before,
        afterJson: doc.toObject()
    });
    await invalidatePlatformFeaturesCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: doc });
});
