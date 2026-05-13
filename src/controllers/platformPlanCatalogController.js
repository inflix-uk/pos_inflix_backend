const PlanCatalog = require('../models/PlanCatalog');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { mapToObject } = require('../services/entitlementsService');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const PLATFORM_PLANS_NS = 'platform:plans';
const /* deprecated */ PLATFORM_SCOPE = 'global';
async function invalidatePlatformPlansCache(tenantId) { await cache.bumpNs(PLATFORM_PLANS_NS, tenantId); }

exports.list = asyncHandler(async (req, res) => {
    const activeOnly = req.query.active !== 'false';
    const data = await cache.cached(
        { ns: PLATFORM_PLANS_NS, tenantId: getTenantIdFromReq(req), params: { activeOnly }, ttlSec: TTL.REFERENCE },
        async () => {
            const query = activeOnly ? { isActive: true } : {};
            const items = await PlanCatalog.find(query).sort({ planKey: 1 }).lean();
            return items.map((p) => ({
                ...p,
                features: mapToObject(p.features),
                limits: mapToObject(p.limits)
            }));
        }
    );
    res.status(200).json({ success: true, data });
});

exports.create = asyncHandler(async (req, res) => {
    const { planKey, name, description, priceMetadata, features, limits, isActive } = req.body;
    const key = (planKey || '').trim().toLowerCase();
    if (!key) return res.status(400).json({ success: false, message: 'planKey is required' });
    const existing = await PlanCatalog.findOne({ planKey: key });
    if (existing) return res.status(400).json({ success: false, message: 'Plan key already exists' });
    const doc = await PlanCatalog.create({
        planKey: key,
        name: (name || key).trim(),
        description: (description || '').trim(),
        priceMetadata: priceMetadata || null,
        features: features && typeof features === 'object' ? features : {},
        limits: limits && typeof limits === 'object' ? limits : {},
        isActive: isActive !== false
    });
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_PLAN_CATALOG_CREATED',
        entityType: 'PlanCatalog',
        entityId: doc._id,
        success: true,
        message: `Plan ${doc.planKey} created`,
        afterJson: doc.toObject ? doc.toObject() : doc
    });
    await invalidatePlatformPlansCache(getTenantIdFromReq(req));
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    const doc = await PlanCatalog.findOne({ planKey: req.params.planKey });
    if (!doc) return res.status(404).json({ success: false, message: 'Plan not found' });
    const before = doc.toObject();
    const { name, description, priceMetadata, features, limits, isActive } = req.body;
    if (name !== undefined) doc.name = name.trim();
    if (description !== undefined) doc.description = description.trim();
    if (priceMetadata !== undefined) doc.priceMetadata = priceMetadata;
    if (features !== undefined && typeof features === 'object') doc.features = features;
    if (limits !== undefined && typeof limits === 'object') doc.limits = limits;
    if (isActive !== undefined) doc.isActive = !!isActive;
    await doc.save();
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_PLAN_CATALOG_UPDATED',
        entityType: 'PlanCatalog',
        entityId: doc._id,
        success: true,
        message: `Plan ${doc.planKey} updated`,
        beforeJson: before,
        afterJson: doc.toObject()
    });
    await invalidatePlatformPlansCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: doc });
});

exports.deletePlan = asyncHandler(async (req, res) => {
    const doc = await PlanCatalog.findOne({ planKey: req.params.planKey });
    if (!doc) return res.status(404).json({ success: false, message: 'Plan not found' });
    const planKey = doc.planKey;
    await PlanCatalog.deleteOne({ _id: doc._id });
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_PLAN_CATALOG_DELETED',
        entityType: 'PlanCatalog',
        entityId: doc._id,
        success: true,
        message: `Plan ${planKey} deleted`,
        beforeJson: doc.toObject()
    });
    await invalidatePlatformPlansCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, message: 'Plan deleted' });
});
