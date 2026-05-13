const AuditEvent = require('../models/AuditEvent');
const { AUDIT_ACTIONS, ENTITY_TYPES } = require('../models/AuditEvent');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const ACTIVITY_LOG_LIST_NS = 'activityLog:list';

/**
 * GET /api/activity-log
 * Query: fromUtc, toUtc, imei, customerId, userId, invoiceNo, saleId, productId, action, entityType, success, source, search, page, limit, sort
 */
exports.getActivityLog = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const sortOrder = req.query.sort === 'asc' ? 1 : -1;
    const tenantId = getTenantIdFromReq(req);

    const params = {
        page, limit, sortOrder,
        fromUtc: req.query.fromUtc || null,
        toUtc: req.query.toUtc || null,
        imei: (req.query.imei || '').trim() || null,
        customerId: (req.query.customerId || '').trim() || null,
        userId: (req.query.userId || '').trim() || null,
        invoiceNo: (req.query.invoiceNo || '').trim() || null,
        saleId: (req.query.saleId || '').trim() || null,
        productId: (req.query.productId || '').trim() || null,
        action: (req.query.action || '').trim() || null,
        entityType: (req.query.entityType || '').trim() || null,
        success: req.query.success !== undefined && req.query.success !== '' ? String(req.query.success) : null,
        source: (req.query.source || '').trim() || null,
        search: (req.query.search || '').trim() || null
    };

    const payload = await cache.cached(
        { ns: ACTIVITY_LOG_LIST_NS, tenantId, params, ttlSec: TTL.ACTIVITY },
        async () => {
            const skip = (page - 1) * limit;
            const query = { tenantId: tenantId || 'default' };

            if (req.query.fromUtc) {
                query.occurredAtUtc = query.occurredAtUtc || {};
                query.occurredAtUtc.$gte = new Date(req.query.fromUtc);
            }
            if (req.query.toUtc) {
                query.occurredAtUtc = query.occurredAtUtc || {};
                query.occurredAtUtc.$lte = new Date(req.query.toUtc);
            }
            if (req.query.imei && req.query.imei.trim()) {
                query.imei = { $regex: req.query.imei.trim(), $options: 'i' };
            }
            if (req.query.customerId && req.query.customerId.trim()) {
                query.customerId = req.query.customerId.trim();
            }
            if (req.query.userId && req.query.userId.trim()) {
                query.actorUserId = req.query.userId.trim();
            }
            if (req.query.invoiceNo && req.query.invoiceNo.trim()) {
                query.invoiceNo = { $regex: req.query.invoiceNo.trim(), $options: 'i' };
            }
            if (req.query.saleId && req.query.saleId.trim()) {
                query.saleId = req.query.saleId.trim();
            }
            if (req.query.productId && req.query.productId.trim()) {
                query.productId = req.query.productId.trim();
            }
            if (req.query.action && req.query.action.trim()) {
                query.action = req.query.action.trim();
            }
            if (req.query.entityType && req.query.entityType.trim()) {
                query.entityType = req.query.entityType.trim();
            }
            if (req.query.success !== undefined && req.query.success !== '') {
                query.success = req.query.success === 'true' || req.query.success === true;
            }
            if (req.query.source && req.query.source.trim()) {
                query.source = req.query.source.trim();
            }

            if (req.query.search && req.query.search.trim()) {
                const q = req.query.search.trim();
                query.$or = [
                    { message: { $regex: q, $options: 'i' } },
                    { invoiceNo: { $regex: q, $options: 'i' } },
                    { imei: { $regex: q, $options: 'i' } },
                    { actorName: { $regex: q, $options: 'i' } }
                ];
            }

            const [list, total] = await Promise.all([
                AuditEvent.find(query)
                    .sort({ occurredAtUtc: sortOrder })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                AuditEvent.countDocuments(query)
            ]);

            const data = list.map((doc) => ({
                id: doc._id.toString(),
                occurredAtUtc: doc.occurredAtUtc,
                actorUserId: doc.actorUserId ? doc.actorUserId.toString() : null,
                actorName: doc.actorName || '',
                actorRole: doc.actorRole || '',
                action: doc.action,
                entityType: doc.entityType,
                entityId: doc.entityId != null ? (doc.entityId.toString ? doc.entityId.toString() : doc.entityId) : null,
                success: doc.success,
                message: doc.message || '',
                customerId: doc.customerId ? doc.customerId.toString() : null,
                saleId: doc.saleId ? doc.saleId.toString() : null,
                invoiceNo: doc.invoiceNo || '',
                productId: doc.productId ? doc.productId.toString() : null,
                imei: doc.imei || '',
                amount: doc.amount,
                paymentMethod: doc.paymentMethod,
                source: doc.source || 'API',
                ipAddress: doc.ipAddress || '',
                diffJson: doc.diffJson,
                beforeJson: doc.beforeJson,
                afterJson: doc.afterJson,
                metaJson: doc.metaJson,
                hash: doc.hash
            }));

            return { data, total };
        }
    );

    res.status(200).json({
        success: true,
        data: payload.data,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit) || 1,
        limit
    });
});

/**
 * GET /api/activity-log/:id - single event with full detail
 */
exports.getActivityLogById = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await AuditEvent.findOne({ _id: req.params.id, tenantId: tenantId || 'default' }).lean();
    if (!doc) {
        return res.status(404).json({ success: false, message: 'Event not found' });
    }
    res.status(200).json({
        success: true,
        data: {
            id: doc._id.toString(),
            occurredAtUtc: doc.occurredAtUtc,
            actorUserId: doc.actorUserId ? doc.actorUserId.toString() : null,
            actorName: doc.actorName || '',
            actorRole: doc.actorRole || '',
            action: doc.action,
            entityType: doc.entityType,
            entityId: doc.entityId != null ? (doc.entityId.toString ? doc.entityId.toString() : doc.entityId) : null,
            success: doc.success,
            message: doc.message || '',
            customerId: doc.customerId ? doc.customerId.toString() : null,
            saleId: doc.saleId ? doc.saleId.toString() : null,
            invoiceNo: doc.invoiceNo || '',
            productId: doc.productId ? doc.productId.toString() : null,
            imei: doc.imei || '',
            amount: doc.amount,
            paymentMethod: doc.paymentMethod,
            source: doc.source || 'API',
            ipAddress: doc.ipAddress || '',
            userAgent: doc.userAgent || '',
            diffJson: doc.diffJson,
            beforeJson: doc.beforeJson,
            afterJson: doc.afterJson,
            metaJson: doc.metaJson,
            prevHash: doc.prevHash,
            hash: doc.hash
        }
    });
});

/**
 * GET /api/activity-log/options - action and entity type enums for filters
 */
exports.getActivityLogOptions = asyncHandler(async (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            actions: AUDIT_ACTIONS,
            entityTypes: ENTITY_TYPES,
            sources: ['UI', 'API', 'import', 'system']
        }
    });
});
