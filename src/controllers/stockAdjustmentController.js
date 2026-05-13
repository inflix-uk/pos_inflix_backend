const mongoose = require('mongoose');
const StockAdjustment = require('../models/StockAdjustment');
const StockMove = require('../models/StockMove');
const Location = require('../models/Location');
const Product = require('../models/Product');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const stockAdjustmentService = require('../services/stockAdjustmentService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const ADJUSTMENT_INVALIDATE_NS = ['stockAdjustments:list', 'products:list', 'products:lowStock'];

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

const STATUS = stockAdjustmentService.STATUS;
const REASON_CODES = stockAdjustmentService.REASON_CODES || ['COUNT_CORRECTION', 'DAMAGED', 'LOST_STOLEN', 'SUPPLIER_DISCREPANCY', 'DATA_FIX', 'OTHER'];

exports.list = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view stock adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    // Cache key includes user-scoped locations because access control filters results per user.
    const userScopeKey = (() => {
        const scope = getUserLocationScope(req.user);
        if (!scope || scope.length === 0) return '_all';
        return scope.map((id) => String(id)).sort().join(',');
    })();

    const params = {
        page, limit,
        status: req.query.status || null,
        locationId: req.query.locationId || null,
        reasonCode: req.query.reasonCode || null,
        fromUtc: req.query.fromUtc || null,
        toUtc: req.query.toUtc || null,
        search: req.query.search || null,
        imei: req.query.imei || null,
        userScopeKey,
    };

    const payload = await cache.cached(
        { ns: 'stockAdjustments:list', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => buildStockAdjustmentList(req, { tenantId, page, limit, skip })
    );

    res.json({
        success: true,
        data: payload.items,
        pagination: { page, limit, total: payload.total, pages: Math.ceil(payload.total / limit) }
    });
});

async function buildStockAdjustmentList(req, { tenantId, page, limit, skip }) {
    const filter = { tenantId };
    
    // Phase 3: Location-based access control
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        // Non-admin: filter by assigned locations
        filter.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    // Admin or empty assignedLocationIds: no location filter (see all locations)
    
    if (req.query.status) filter.status = req.query.status;
    if (req.query.locationId) {
        // If query specifies locationId, validate it's in user scope
        const queryLocationId = req.query.locationId;
        if (userScope && userScope.length > 0) {
            const queryLocationIdStr = queryLocationId.toString ? queryLocationId.toString() : String(queryLocationId);
            if (!userScope.includes(queryLocationIdStr)) {
                // User requested location outside scope - return empty result
                filter.locationId = new mongoose.Types.ObjectId('000000000000000000000000'); // Invalid ID, no matches
            } else {
                filter.locationId = new mongoose.Types.ObjectId(queryLocationId);
            }
        } else {
            filter.locationId = new mongoose.Types.ObjectId(queryLocationId);
        }
    }
    if (req.query.reasonCode) filter.reasonCode = req.query.reasonCode;
    if (req.query.fromUtc) {
        filter.createdAt = filter.createdAt || {};
        filter.createdAt.$gte = new Date(req.query.fromUtc);
    }
    if (req.query.toUtc) {
        filter.createdAt = filter.createdAt || {};
        filter.createdAt.$lte = new Date(req.query.toUtc);
    }
    if (req.query.search && req.query.search.trim()) {
        filter.adjustmentNo = new RegExp(req.query.search.trim(), 'i');
    }
    if (req.query.imei && req.query.imei.trim()) {
        filter['serials.serialOrImei'] = new RegExp('^' + req.query.imei.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    }

    const [items, total] = await Promise.all([
        StockAdjustment.find(filter)
            .populate('locationId', 'name type')
            .populate('createdByUserId', 'name')
            .populate('postedByUserId', 'name')
            .populate('cancelledByUserId', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        StockAdjustment.countDocuments(filter)
    ]);

    return { items, total };
}

exports.getById = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view stock adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId })
        .populate('locationId', 'name type address city')
        .populate('createdByUserId', 'name')
        .populate('postedByUserId', 'name')
        .populate('cancelledByUserId', 'name')
        .populate('lines.productId', 'name sku barcode')
        .populate('serials.productId', 'name sku barcode')
        .lean();
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    
    // Phase 3: Location-based access control - verify user can access this adjustment's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && adjustment.locationId) {
        const adjustmentLocationId = adjustment.locationId._id ? adjustment.locationId._id.toString() : String(adjustment.locationId);
        if (!userScope.includes(adjustmentLocationId)) {
            return res.status(404).json({ success: false, message: 'Adjustment not found' });
        }
    }

    const moves = await StockMove.find({ tenantId, adjustmentId: req.params.id }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: adjustment, stockMoves: moves });
});

exports.create = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to create stock adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const { locationId, reasonCode, notes } = req.body || {};
    if (!locationId) {
        return res.status(400).json({ success: false, message: 'locationId is required' });
    }
    
    // Phase 3: Location-based access control - validate locationId is in allowed locations
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        const locationIdStr = locationId.toString ? locationId.toString() : String(locationId);
        if (!userScope.includes(locationIdStr)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to create adjustments for this location'
            });
        }
    }
    
    if (!reasonCode || !REASON_CODES.includes(reasonCode)) {
        return res.status(400).json({ success: false, message: 'reasonCode is required and must be one of: ' + REASON_CODES.join(', ') });
    }
    if (reasonCode === 'OTHER' && (!notes || !String(notes).trim())) {
        return res.status(400).json({ success: false, message: 'notes are required when reasonCode is OTHER' });
    }

    const loc = await Location.findOne({ _id: locationId, tenantId }).select('_id').lean();
    if (!loc) return res.status(400).json({ success: false, message: 'Location not found' });

    const adjustmentNo = await stockAdjustmentService.generateAdjustmentNo(tenantId);
    const doc = await StockAdjustment.create({
        tenantId,
        adjustmentNo,
        locationId,
        status: STATUS.DRAFT,
        reasonCode,
        notes: (notes && String(notes).trim()) || '',
        createdByUserId: req.user._id,
        lines: [],
        serials: []
    });

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_CREATED',
        entityType: 'StockAdjustment',
        entityId: doc._id,
        success: true,
        message: `Adjustment ${doc.adjustmentNo} created`,
        afterJson: { adjustmentNo: doc.adjustmentNo, locationId: doc.locationId, reasonCode: doc.reasonCode },
        metaJson: { locationId: doc.locationId.toString() }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to edit draft adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    
    // Phase 3: Location-based access control - verify user can access this adjustment's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && adjustment.locationId) {
        const adjustmentLocationId = adjustment.locationId.toString ? adjustment.locationId.toString() : String(adjustment.locationId);
        if (!userScope.includes(adjustmentLocationId)) {
            return res.status(404).json({ success: false, message: 'Adjustment not found' });
        }
    }
    
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be edited' });
    }
    
    // Phase 3: If update includes locationId, validate it's in allowed locations
    if (req.body.locationId !== undefined) {
        const newLocationId = req.body.locationId;
        if (userScope && userScope.length > 0 && newLocationId) {
            const newLocationIdStr = newLocationId.toString ? newLocationId.toString() : String(newLocationId);
            if (!userScope.includes(newLocationIdStr)) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to assign adjustments to this location'
                });
            }
        }
    }

    const { locationId, reasonCode, notes } = req.body || {};
    if (reasonCode !== undefined) {
        if (!REASON_CODES.includes(reasonCode)) {
            return res.status(400).json({ success: false, message: 'Invalid reasonCode' });
        }
        adjustment.reasonCode = reasonCode;
        if (reasonCode === 'OTHER' && (!notes || !String(notes).trim())) {
            return res.status(400).json({ success: false, message: 'notes are required when reasonCode is OTHER' });
        }
    }
    if (locationId != null) {
        const loc = await Location.findOne({ _id: locationId, tenantId }).select('_id').lean();
        if (!loc) return res.status(400).json({ success: false, message: 'Location not found' });
        adjustment.locationId = locationId;
    }
    if (notes !== undefined) adjustment.notes = String(notes).trim();
    await adjustment.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_UPDATED',
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
        success: true,
        message: `Adjustment ${adjustment.adjustmentNo} updated`,
        diffJson: { locationId: adjustment.locationId, reasonCode: adjustment.reasonCode, notes: adjustment.notes }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: adjustment });
});

exports.addLine = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.create') && !can(req.user, 'stock_adjustment.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to add lines' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be modified' });
    }

    const { productId, deltaQty } = req.body || {};
    if (!productId) return res.status(400).json({ success: false, message: 'productId is required' });
    if (deltaQty == null || deltaQty === 0) {
        return res.status(400).json({ success: false, message: 'deltaQty is required and must not be zero' });
    }

    const product = await Product.findOne({ _id: productId, tenantId }).select('_id').lean();
    if (!product) return res.status(400).json({ success: false, message: 'Product not found' });

    const { cost, costMissing } = await stockAdjustmentService.resolveCostForProduct(productId, adjustment.locationId, tenantId);
    const valueSnapshot = Math.abs(Number(deltaQty)) * cost;
    const line = {
        productId,
        deltaQty: Number(deltaQty),
        unitCostSnapshot: cost,
        valueSnapshot,
        costMissing
    };
    adjustment.lines = adjustment.lines || [];
    adjustment.lines.push(line);
    await adjustment.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_LINE_ADDED',
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
        success: true,
        message: `Line added to ${adjustment.adjustmentNo}`,
        productId,
        metaJson: { adjustmentNo: adjustment.adjustmentNo, deltaQty: line.deltaQty, valueSnapshot: line.valueSnapshot }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: adjustment });
});

exports.removeLine = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.create') && !can(req.user, 'stock_adjustment.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to remove lines' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be modified' });
    }
    const lineId = req.params.lineId;
    const before = (adjustment.lines || []).length;
    adjustment.lines = (adjustment.lines || []).filter((l) => String(l._id) !== String(lineId));
    if (adjustment.lines.length === before) {
        return res.status(404).json({ success: false, message: 'Line not found' });
    }
    await adjustment.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_LINE_REMOVED',
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
        success: true,
        message: `Line removed from ${adjustment.adjustmentNo}`,
        metaJson: { adjustmentNo: adjustment.adjustmentNo, lineId }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: adjustment });
});

exports.addSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.create') && !can(req.user, 'stock_adjustment.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to add serials' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be modified' });
    }

    const { serialOrImei, direction } = req.body || {};
    const serial = serialOrImei && String(serialOrImei).trim();
    if (!serial) return res.status(400).json({ success: false, message: 'serialOrImei is required' });
    if (!direction || !['IN', 'OUT'].includes(direction)) {
        return res.status(400).json({ success: false, message: 'direction must be IN or OUT' });
    }

    const existingInAdj = (adjustment.serials || []).find((s) => stockAdjustmentService.normalizeSerial(s.serialOrImei) === stockAdjustmentService.normalizeSerial(serial));
    if (existingInAdj) {
        return res.status(400).json({ success: false, message: 'Duplicate serial in this adjustment' });
    }

    const check = await stockAdjustmentService.validateSerialForAdjustment(serial, adjustment.locationId, direction, adjustment._id, tenantId);
    if (!check.valid) {
        return res.status(400).json({ success: false, message: check.reason });
    }

    const productId = check.productId || await stockAdjustmentService.resolveProductForSerial(serial, tenantId);
    const { cost, costMissing } = await stockAdjustmentService.resolveCostForSerial(serial, tenantId);
    const valueSnapshot = cost;
    const serialEntry = {
        productId: productId || null,
        serialOrImei: serial,
        direction,
        unitCostSnapshot: cost,
        valueSnapshot,
        costMissing
    };
    adjustment.serials = adjustment.serials || [];
    adjustment.serials.push(serialEntry);
    await adjustment.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_SERIAL_ADDED',
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
        success: true,
        message: `Serial ${serial} added to ${adjustment.adjustmentNo}`,
        imei: serial,
        metaJson: { adjustmentNo: adjustment.adjustmentNo, direction, serialOrImei: serial }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: adjustment });
});

exports.removeSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.create') && !can(req.user, 'stock_adjustment.edit_draft')) {
        return res.status(403).json({ success: false, message: 'Not allowed to remove serials' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be modified' });
    }
    const serialParam = req.params.serialOrImei;
    const normalized = stockAdjustmentService.normalizeSerial(serialParam);
    const before = (adjustment.serials || []).length;
    adjustment.serials = (adjustment.serials || []).filter((s) => stockAdjustmentService.normalizeSerial(s.serialOrImei) !== normalized);
    if (adjustment.serials.length === before) {
        return res.status(404).json({ success: false, message: 'Serial not found in this adjustment' });
    }
    await adjustment.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_ADJUSTMENT_SERIAL_REMOVED',
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
        success: true,
        message: `Serial removed from ${adjustment.adjustmentNo}`,
        imei: normalized,
        metaJson: { adjustmentNo: adjustment.adjustmentNo, serialOrImei: normalized }
    });

    await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: adjustment });
});

exports.validateSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.view') && !can(req.user, 'stock_adjustment.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId }).select('locationId serials').lean();
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    const serial = (req.query.serial || req.query.imei || '').toString().trim();
    const direction = (req.query.direction || 'OUT').toUpperCase();
    if (!serial) {
        return res.json({ success: true, valid: false, reason: 'Serial is empty' });
    }
    const check = await stockAdjustmentService.validateSerialForAdjustment(
        serial,
        adjustment.locationId,
        direction === 'IN' ? 'IN' : 'OUT',
        req.params.id,
        tenantId
    );
    const productId = check.productId ? check.productId.toString() : null;
    res.json({ success: true, valid: check.valid, reason: check.reason || null, productId });
});

exports.post = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.post')) {
        return res.status(403).json({ success: false, message: 'Not allowed to post adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    
    // Phase 3: Location-based access control - verify user can access this adjustment's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && adjustment.locationId) {
        const adjustmentLocationId = adjustment.locationId.toString ? adjustment.locationId.toString() : String(adjustment.locationId);
        if (!userScope.includes(adjustmentLocationId)) {
            return res.status(404).json({ success: false, message: 'Adjustment not found' });
        }
    }
    
    if (adjustment.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft adjustments can be posted' });
    }

    const allowCostMissingOverride = can(req.user, 'stock_adjustment.override_missing_cost');
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        await stockAdjustmentService.postAdjustment(
            req.params.id,
            tenantId,
            req.user._id,
            session,
            { allowCostMissingOverride }
        );
        const updated = await StockAdjustment.findOne({ _id: req.params.id, tenantId })
            .populate('locationId', 'name')
            .populate('postedByUserId', 'name')
            .session(session)
            .lean();
        await activityLogService.logFromReq(req, {
            action: 'STOCK_ADJUSTMENT_POSTED',
            entityType: 'StockAdjustment',
            entityId: adjustment._id,
            success: true,
            message: `Adjustment ${adjustment.adjustmentNo} posted`,
            metaJson: {
                adjustmentNo: adjustment.adjustmentNo,
                locationId: adjustment.locationId.toString(),
                reasonCode: adjustment.reasonCode,
                totalQtyIn: updated.totalQtyIn,
                totalQtyOut: updated.totalQtyOut,
                totalValueIn: updated.totalValueIn,
                totalValueOut: updated.totalValueOut,
                serialCount: (adjustment.serials || []).length
            },
            session
        });
        await session.commitTransaction();
        const serialIndexService = require('../services/serialIndexService');
        const locationId = adjustment.locationId;
        for (const ser of (adjustment.serials || [])) {
            const serial = (ser.serialOrImei && String(ser.serialOrImei).trim()) || '';
            if (!serial) continue;
            const status = ser.direction === 'OUT' ? 'adjusted_out' : 'in_stock';
            serialIndexService.upsertSerialIndex(tenantId, { serial, status, locationId: status === 'in_stock' ? locationId : null }).catch(() => {});
        }
        const fresh = await StockAdjustment.findOne({ _id: req.params.id, tenantId })
            .populate('locationId', 'name type')
            .populate('createdByUserId', 'name')
            .populate('postedByUserId', 'name')
            .populate('lines.productId', 'name sku barcode')
            .populate('serials.productId', 'name sku barcode')
            .lean();
        await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
        res.json({ success: true, data: fresh });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});

exports.cancel = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_adjustment.cancel')) {
        return res.status(403).json({ success: false, message: 'Not allowed to cancel adjustments' });
    }
    const tenantId = getTenantIdFromReq(req);
    const adjustment = await StockAdjustment.findOne({ _id: req.params.id, tenantId });
    if (!adjustment) return res.status(404).json({ success: false, message: 'Adjustment not found' });
    
    // Phase 3: Location-based access control - verify user can access this adjustment's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && adjustment.locationId) {
        const adjustmentLocationId = adjustment.locationId.toString ? adjustment.locationId.toString() : String(adjustment.locationId);
        if (!userScope.includes(adjustmentLocationId)) {
            return res.status(404).json({ success: false, message: 'Adjustment not found' });
        }
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        await stockAdjustmentService.cancelAdjustment(req.params.id, req.user._id, session, tenantId);
        await activityLogService.logFromReq(req, {
            action: 'STOCK_ADJUSTMENT_CANCELLED',
            entityType: 'StockAdjustment',
            entityId: adjustment._id,
            success: true,
            message: `Adjustment ${adjustment.adjustmentNo} cancelled`,
            metaJson: { adjustmentNo: adjustment.adjustmentNo, previousStatus: adjustment.status },
            session
        });
        await session.commitTransaction();
        const fresh = await StockAdjustment.findOne({ _id: req.params.id, tenantId })
            .populate('locationId', 'name type')
            .populate('createdByUserId', 'name')
            .populate('cancelledByUserId', 'name')
            .lean();
        await cache.bumpMany(ADJUSTMENT_INVALIDATE_NS, tenantId);
        res.json({ success: true, data: fresh });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});

exports.getReasonCodes = (_req, res) => {
    res.json({ success: true, data: REASON_CODES });
};
