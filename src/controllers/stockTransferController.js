const StockTransfer = require('../models/StockTransfer');
const StockMove = require('../models/StockMove');
const Location = require('../models/Location');
const Product = require('../models/Product');
const Purchase = require('../models/Purchase');
const Category = require('../models/Category');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const stockTransferService = require('../services/stockTransferService');
const { getNonSerialStockRowsForTransfer } = require('./purchaseController');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const TRANSFER_INVALIDATE_NS = ['stockTransfers:list', 'products:list'];

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

const STATUS = stockTransferService.STATUS;

exports.list = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view stock transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    // Cache key includes user-scoped locations because access control filters results per user.
    const locationScope = getUserLocationScope(req.user);
    const userScopeKey = locationScope === null
        ? '_all'
        : (locationScope.length === 0 ? '_none' : locationScope.map((id) => String(id)).sort().join(','));

    const params = {
        page, limit,
        status: req.query.status || null,
        fromLocationId: req.query.fromLocationId || null,
        toLocationId: req.query.toLocationId || null,
        fromUtc: req.query.fromUtc || null,
        toUtc: req.query.toUtc || null,
        search: req.query.search || null,
        imei: req.query.imei || null,
        userScopeKey,
    };

    const payload = await cache.cached(
        { ns: 'stockTransfers:list', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => {
            const filter = { tenantId };
            if (req.query.status) filter.status = req.query.status;
            if (req.query.fromLocationId) filter.fromLocationId = req.query.fromLocationId;
            if (req.query.toLocationId) filter.toLocationId = req.query.toLocationId;
            if (req.query.fromUtc) {
                filter.createdAt = filter.createdAt || {};
                filter.createdAt.$gte = new Date(req.query.fromUtc);
            }
            if (req.query.toUtc) {
                filter.createdAt = filter.createdAt || {};
                filter.createdAt.$lte = new Date(req.query.toUtc);
            }
            if (req.query.search && req.query.search.trim()) {
                filter.transferNo = new RegExp(req.query.search.trim(), 'i');
            }
            if (req.query.imei && req.query.imei.trim()) {
                filter['serials.serialOrImei'] = new RegExp('^' + req.query.imei.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
            }

            // Phase 3 follow-up: Location-based access control
            if (locationScope !== null) {
                // Non-admin: filter by assigned locations (fromLocationId OR toLocationId in scope)
                filter.$or = [
                    { fromLocationId: { $in: locationScope } },
                    { toLocationId: { $in: locationScope } }
                ];
            }

            const [items, total] = await Promise.all([
                StockTransfer.find(filter)
                    .populate('fromLocationId', 'name type')
                    .populate('toLocationId', 'name type')
                    .populate('createdByUserId', 'name')
                    .populate('dispatchedByUserId', 'name')
                    .populate('receivedByUserId', 'name')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                StockTransfer.countDocuments(filter)
            ]);
            return { items, total };
        }
    );

    res.json({
        success: true,
        data: payload.items,
        pagination: { page, limit, total: payload.total, pages: Math.ceil(payload.total / limit) }
    });
});

exports.getById = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view stock transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId })
        .populate('fromLocationId', 'name type address city')
        .populate('toLocationId', 'name type address city')
        .populate('createdByUserId', 'name')
        .populate('dispatchedByUserId', 'name')
        .populate('receivedByUserId', 'name')
        .populate('lines.productId', 'name sku barcode')
        .populate('serials.productId', 'name sku barcode')
        .lean();
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });

    // Phase 3 follow-up: Location-based access control
    const locationScope = getUserLocationScope(req.user);
    if (locationScope !== null) {
        const fromId = transfer.fromLocationId?._id?.toString() || transfer.fromLocationId?.toString();
        const toId = transfer.toLocationId?._id?.toString() || transfer.toLocationId?.toString();
        const fromInScope = fromId && locationScope.includes(fromId);
        const toInScope = toId && locationScope.includes(toId);
        if (!fromInScope && !toInScope) {
            return res.status(404).json({ success: false, message: 'Transfer not found' });
        }
    }

    const moves = await StockMove.find({ tenantId, transferId: req.params.id }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: transfer, stockMoves: moves });
});

exports.create = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to create stock transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const { fromLocationId, toLocationId, notes } = req.body || {};
    if (!fromLocationId || !toLocationId) {
        return res.status(400).json({ success: false, message: 'fromLocationId and toLocationId are required' });
    }
    const fromId = fromLocationId.toString();
    const toId = toLocationId.toString();
    if (fromId === toId) {
        return res.status(400).json({ success: false, message: 'From and to location must be different' });
    }
    const [fromLoc, toLoc] = await Promise.all([
        Location.findOne({ _id: fromLocationId, tenantId }).select('_id').lean(),
        Location.findOne({ _id: toLocationId, tenantId }).select('_id').lean()
    ]);
    if (!fromLoc || !toLoc) {
        return res.status(400).json({ success: false, message: 'One or both locations not found' });
    }

    // Phase 3 follow-up: Location-based access control - user must have access to both locations
    const locationScope = getUserLocationScope(req.user);
    if (locationScope !== null) {
        if (!locationScope.includes(fromId) || !locationScope.includes(toId)) {
            return res.status(403).json({ success: false, message: 'You do not have access to one or both of the specified locations' });
        }
    }

    const transferNo = await stockTransferService.generateTransferNo(tenantId);
    const doc = await StockTransfer.create({
        tenantId,
        transferNo,
        fromLocationId,
        toLocationId,
        status: STATUS.DRAFT,
        notes: notes || '',
        createdByUserId: req.user._id,
        lines: [],
        serials: []
    });

    await activityLogService.logFromReq(req, {
        action: 'STOCK_TRANSFER_CREATED',
        entityType: 'StockTransfer',
        entityId: doc._id,
        success: true,
        message: `Transfer ${doc.transferNo} created`,
        afterJson: { transferNo: doc.transferNo, fromLocationId: doc.fromLocationId, toLocationId: doc.toLocationId },
        metaJson: { fromLocationId: fromId, toLocationId: toId }
    });

    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.status(201).json({ success: true, data: doc });
});

exports.update = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to edit stock transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be edited' });
    }

    // Phase 3 follow-up: Location-based access control - verify user can access current transfer
    const locationScope = getUserLocationScope(req.user);
    if (locationScope !== null) {
        const currentFromId = transfer.fromLocationId?.toString();
        const currentToId = transfer.toLocationId?.toString();
        const fromInScope = currentFromId && locationScope.includes(currentFromId);
        const toInScope = currentToId && locationScope.includes(currentToId);
        if (!fromInScope && !toInScope) {
            return res.status(404).json({ success: false, message: 'Transfer not found' });
        }
    }

    const { fromLocationId, toLocationId, notes } = req.body || {};
    const newFromId = fromLocationId != null ? fromLocationId.toString() : (transfer.fromLocationId?.toString());
    const newToId = toLocationId != null ? toLocationId.toString() : (transfer.toLocationId?.toString());
    
    // Phase 3 follow-up: Validate new locations if changed
    if (fromLocationId != null || toLocationId != null) {
        if (locationScope !== null) {
            if (newFromId && !locationScope.includes(newFromId)) {
                return res.status(403).json({ success: false, message: 'You do not have access to the from location' });
            }
            if (newToId && !locationScope.includes(newToId)) {
                return res.status(403).json({ success: false, message: 'You do not have access to the to location' });
            }
        }
        // Validate locations belong to tenant
        if (fromLocationId != null) {
            const fromLoc = await Location.findOne({ _id: fromLocationId, tenantId }).select('_id').lean();
            if (!fromLoc) {
                return res.status(400).json({ success: false, message: 'From location not found' });
            }
        }
        if (toLocationId != null) {
            const toLoc = await Location.findOne({ _id: toLocationId, tenantId }).select('_id').lean();
            if (!toLoc) {
                return res.status(400).json({ success: false, message: 'To location not found' });
            }
        }
    }
    
    if (fromLocationId != null) transfer.fromLocationId = fromLocationId;
    if (toLocationId != null) transfer.toLocationId = toLocationId;
    if (notes !== undefined) transfer.notes = notes;

    if (newFromId && newToId && newFromId === newToId) {
        return res.status(400).json({ success: false, message: 'From and to location must be different' });
    }
    await transfer.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_TRANSFER_UPDATED',
        entityType: 'StockTransfer',
        entityId: transfer._id,
        success: true,
        message: `Transfer ${transfer.transferNo} updated`,
        diffJson: { fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, notes: transfer.notes }
    });

    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: transfer });
});

exports.getQuantityLineOptions = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.view') && !can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const tenantId = getTenantIdFromReq(req);
    const fromLocationId = (req.query.fromLocationId || '').toString().trim() || null;
    const [products, invRows] = await Promise.all([
        Product.find({ tenantId, isActive: true }).select('_id name sku').sort('name').limit(500).lean(),
        getNonSerialStockRowsForTransfer(tenantId, fromLocationId)
    ]);
    const options = [];
    const seenProductIds = new Set();
    products.forEach((p) => {
        seenProductIds.add(p._id.toString());
        options.push({
            id: p._id.toString(),
            label: (p.name || p.sku || p._id.toString()).trim(),
            productId: p._id.toString(),
            source: 'product'
        });
    });
    invRows.forEach((r) => {
        const label = [r.name, r.brand, r.brandModel].filter(Boolean).join(' ').trim() || r.barcode || `Item ${r.purchaseId}`;
        options.push({
            id: `inv-${r.purchaseId}-${r.itemId}`,
            label: label + (r.quantity ? ` (qty ${r.quantity})` : ''),
            productId: null,
            purchaseId: r.purchaseId,
            itemId: r.itemId,
            source: 'inventory'
        });
    });
    res.json({ success: true, data: options });
});

exports.addLine = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to add lines' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be modified' });
    }
    const { productId, purchaseId, purchaseItemId, qty, unitCost } = req.body || {};
    if (qty == null || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Positive qty is required' });
    }
    let resolvedProductId = productId;
    let linePurchaseId = null;
    let linePurchaseItemId = null;
    if (purchaseId && purchaseItemId) {
        const purchase = await Purchase.findOne({ _id: purchaseId, tenantId }).select('items').lean();
        if (!purchase || !purchase.items) return res.status(400).json({ success: false, message: 'Purchase item not found' });
        const item = purchase.items.find((i) => String(i._id) === String(purchaseItemId));
        if (!item) return res.status(400).json({ success: false, message: 'Purchase item not found' });
        const barcode = (item.barcode && String(item.barcode).trim()) || '';
        const namePart = (item.name && String(item.name).trim()) || [item.brand, item.brandModel].filter(Boolean).join(' ').trim() || 'Inventory item';
        const name = namePart.slice(0, 100);
        let prod = barcode
            ? await Product.findOne({ tenantId, barcode }).select('_id').lean()
            : await Product.findOne({ tenantId, name }).select('_id').lean();
        if (!prod && namePart) {
            prod = await Product.findOne({ tenantId, name: namePart }).select('_id').lean();
        }
        if (!prod) {
            const defaultCategory = await Category.findOne({ isActive: true, itemType: { $in: ['non-serial', 'both'] } }).select('_id').lean()
                || await Category.findOne({ isActive: true }).select('_id').lean();
            if (!defaultCategory) {
                return res.status(400).json({
                    success: false,
                    message: 'No product found for this inventory item and no category exists to create one. Create a product or category first.'
                });
            }
            const costPrice = Number(item.purchasePrice) || 0;
            const sellingPrice = Number(item.salePrice) || costPrice || 0;
            let sku = barcode ? `INV-${barcode.slice(0, 20)}` : `INV-${Date.now()}-${String(purchaseItemId).slice(-6)}`;
            let exists = await Product.findOne({ tenantId, sku }).select('_id').lean();
            let n = 0;
            while (exists) {
                sku = `INV-${Date.now()}-${(n += 1)}`;
                exists = await Product.findOne({ tenantId, sku }).select('_id').lean();
            }
            const newProduct = await Product.create({
                tenantId,
                name,
                sku,
                barcode: barcode || undefined,
                category: defaultCategory._id,
                costPrice,
                sellingPrice,
                quantity: 0,
                isActive: true
            });
            prod = { _id: newProduct._id };
        }
        resolvedProductId = prod._id;
        linePurchaseId = purchaseId;
        linePurchaseItemId = purchaseItemId;
    }
    if (!resolvedProductId) {
        return res.status(400).json({ success: false, message: 'productId or (purchaseId and purchaseItemId) are required' });
    }
    const product = await Product.findOne({ _id: resolvedProductId, tenantId }).select('_id').lean();
    if (!product) return res.status(400).json({ success: false, message: 'Product not found' });
    if (!transfer.lines) transfer.lines = [];
    transfer.lines.push({
        productId: resolvedProductId,
        qty: Number(qty),
        unitCost: unitCost != null ? Number(unitCost) : 0,
        purchaseId: linePurchaseId,
        purchaseItemId: linePurchaseItemId
    });
    await transfer.save();
    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: transfer });
});

exports.removeLine = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to remove lines' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be modified' });
    }
    const lineId = req.params.lineId;
    if (!transfer.lines || !transfer.lines.length) return res.status(400).json({ success: false, message: 'No lines' });
    transfer.lines = transfer.lines.filter((l) => l._id.toString() !== lineId);
    await transfer.save();
    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: transfer });
});

exports.addSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to add serials' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be modified' });
    }
    const serialNumber = (req.body && req.body.serialOrImei) || (req.body && req.body.serialNumber) || req.body;
    const raw = typeof serialNumber === 'string' ? serialNumber : (serialNumber && serialNumber.serialOrImei) || '';
    const serial = stockTransferService.normalizeSerial(raw);
    if (!serial) return res.status(400).json({ success: false, message: 'serialOrImei is required' });

    if (transfer.serials && transfer.serials.some((s) => stockTransferService.normalizeSerial(s.serialOrImei) === serial)) {
        return res.status(400).json({ success: false, message: 'Duplicate serial in this transfer' });
    }

    const validation = await stockTransferService.validateSerialForTransfer(serial, transfer.fromLocationId, transfer._id, tenantId);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.reason || 'Serial cannot be added' });
    }

    if (!transfer.serials) transfer.serials = [];
    transfer.serials.push({
        productId: validation.productId || null,
        serialOrImei: serial,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId
    });
    await transfer.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_TRANSFER_SERIAL_ADDED',
        entityType: 'StockTransfer',
        entityId: transfer._id,
        success: true,
        message: `Serial ${serial} added to ${transfer.transferNo}`,
        imei: serial,
        metaJson: { serialCount: transfer.serials.length }
    });

    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: transfer });
});

exports.removeSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed to remove serials' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be modified' });
    }
    const serial = stockTransferService.normalizeSerial(req.params.serialOrImei || req.body?.serialOrImei || '');
    if (!serial) return res.status(400).json({ success: false, message: 'Serial required' });
    const beforeCount = (transfer.serials && transfer.serials.length) || 0;
    if (transfer.serials) {
        transfer.serials = transfer.serials.filter((s) => stockTransferService.normalizeSerial(s.serialOrImei) !== serial);
    }
    if ((transfer.serials && transfer.serials.length) === beforeCount) {
        return res.status(404).json({ success: false, message: 'Serial not found in this transfer' });
    }
    await transfer.save();

    await activityLogService.logFromReq(req, {
        action: 'STOCK_TRANSFER_SERIAL_REMOVED',
        entityType: 'StockTransfer',
        entityId: transfer._id,
        success: true,
        message: `Serial ${serial} removed from ${transfer.transferNo}`,
        imei: serial,
        metaJson: { serialCount: transfer.serials ? transfer.serials.length : 0 }
    });

    await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
    res.json({ success: true, data: transfer });
});

exports.dispatch = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.dispatch')) {
        return res.status(403).json({ success: false, message: 'Not allowed to dispatch transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be dispatched' });
    }
    
    // Phase 3 follow-up: Location-based access control - verify user can access fromLocationId
    const locationScope = getUserLocationScope(req.user);
    if (locationScope !== null) {
        const fromId = transfer.fromLocationId?.toString();
        if (!fromId || !locationScope.includes(fromId)) {
            return res.status(404).json({ success: false, message: 'Transfer not found' });
        }
    }
    const hasLines = (transfer.lines && transfer.lines.length > 0) || (transfer.serials && transfer.serials.length > 0);
    if (!hasLines) {
        return res.status(400).json({ success: false, message: 'Add at least one line or serial before dispatching' });
    }

    const session = await require('mongoose').startSession();
    session.startTransaction();
    try {
        const updated = await stockTransferService.dispatchTransfer(transfer._id, req.user._id, session, tenantId);
        await activityLogService.log({
            ...activityLogService.contextFromReq(req),
            action: 'STOCK_TRANSFER_DISPATCHED',
            entityType: 'StockTransfer',
            entityId: transfer._id,
            success: true,
            message: `Transfer ${transfer.transferNo} dispatched`,
            afterJson: { status: updated.status, dispatchedAtUtc: updated.dispatchedAtUtc },
            metaJson: { fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, serialCount: (transfer.serials && transfer.serials.length) || 0 },
            session
        });
        await session.commitTransaction();
        const serialIndexService = require('../services/serialIndexService');
        for (const ser of (transfer.serials || [])) {
            const serial = (ser.serialOrImei && String(ser.serialOrImei).trim()) || '';
            if (serial) serialIndexService.upsertSerialIndex(tenantId, { serial, status: 'in_transfer' }).catch(() => {});
        }
        const populated = await StockTransfer.findOne({ _id: updated._id, tenantId })
            .populate('fromLocationId', 'name')
            .populate('toLocationId', 'name')
            .populate('dispatchedByUserId', 'name')
            .lean();
        await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
        res.json({ success: true, data: populated });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});

exports.receive = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.receive')) {
        return res.status(403).json({ success: false, message: 'Not allowed to receive transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DISPATCHED) {
        return res.status(400).json({ success: false, message: 'Only dispatched transfers can be received' });
    }
    
    // Phase 3 follow-up: Location-based access control - verify user can access toLocationId
    const locationScope = getUserLocationScope(req.user);
    if (locationScope !== null) {
        const toId = transfer.toLocationId?.toString();
        if (!toId || !locationScope.includes(toId)) {
            return res.status(404).json({ success: false, message: 'Transfer not found' });
        }
    }

    const session = await require('mongoose').startSession();
    session.startTransaction();
    try {
        const updated = await stockTransferService.receiveTransfer(transfer._id, req.user._id, session, tenantId);
        await activityLogService.log({
            ...activityLogService.contextFromReq(req),
            action: 'STOCK_TRANSFER_RECEIVED',
            entityType: 'StockTransfer',
            entityId: transfer._id,
            success: true,
            message: `Transfer ${transfer.transferNo} received`,
            afterJson: { status: updated.status, receivedAtUtc: updated.receivedAtUtc },
            metaJson: { toLocationId: transfer.toLocationId },
            session
        });
        await session.commitTransaction();
        const serialIndexService = require('../services/serialIndexService');
        const toLocationId = transfer.toLocationId;
        for (const ser of (transfer.serials || [])) {
            const serial = (ser.serialOrImei && String(ser.serialOrImei).trim()) || '';
            if (serial) serialIndexService.upsertSerialIndex(tenantId, { serial, status: 'in_stock', locationId: toLocationId }).catch(() => {});
        }
        const populated = await StockTransfer.findOne({ _id: updated._id, tenantId })
            .populate('fromLocationId', 'name')
            .populate('toLocationId', 'name')
            .populate('receivedByUserId', 'name')
            .lean();
        await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
        res.json({ success: true, data: populated });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});

exports.cancel = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.cancel')) {
        return res.status(403).json({ success: false, message: 'Not allowed to cancel transfers' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transfer = await StockTransfer.findOne({ _id: req.params.id, tenantId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (transfer.status !== STATUS.DRAFT) {
        return res.status(400).json({ success: false, message: 'Only draft transfers can be cancelled' });
    }

    const session = await require('mongoose').startSession();
    session.startTransaction();
    try {
        await stockTransferService.cancelTransfer(transfer._id, session, tenantId);
        await activityLogService.log({
            ...activityLogService.contextFromReq(req),
            action: 'STOCK_TRANSFER_CANCELLED',
            entityType: 'StockTransfer',
            entityId: transfer._id,
            success: true,
            message: `Transfer ${transfer.transferNo} cancelled`,
            session
        });
        await session.commitTransaction();
        const updated = await StockTransfer.findOne({ _id: transfer._id, tenantId }).lean();
        await cache.bumpMany(TRANSFER_INVALIDATE_NS, tenantId);
        res.json({ success: true, data: updated });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});

exports.validateSerial = asyncHandler(async (req, res) => {
    if (!can(req.user, 'stock_transfer.view') && !can(req.user, 'stock_transfer.create')) {
        return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const tenantId = getTenantIdFromReq(req);
    const transferId = req.params.id;
    const transfer = await StockTransfer.findOne({ _id: transferId, tenantId }).select('fromLocationId').lean();
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    const serial = stockTransferService.normalizeSerial(req.query.serial || req.query.imei || req.body?.serialOrImei || '');
    if (!serial) return res.status(400).json({ success: false, message: 'Serial required' });
    const result = await stockTransferService.validateSerialForTransfer(serial, transfer.fromLocationId, transferId, tenantId);
    res.json({ success: true, valid: result.valid, reason: result.reason, productId: result.productId });
});
