const Product = require('../models/Product');
const ProductGroupPrice = require('../models/ProductGroupPrice');
const Category = require('../models/Category');
const Inventory = require('../models/Inventory');
const StockBalance = require('../models/StockBalance');
const StockMove = require('../models/StockMove');
const Sale = require('../models/Sale');
const Purchase = require('../models/Purchase');
const PurchaseReturn = require('../models/PurchaseReturn');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const asyncHandler = require('../middleware/asyncHandler');
const auditService = require('../services/auditService');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { purchasePartyLabel } = require('../utils/supplierDisplay');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { formatProductName } = require('../utils/formatProductName');

const PRODUCT_CACHE_NAMESPACES = ['products:list', 'products:byId', 'products:lowStock', 'products:expired', 'products:expiringSoon'];
async function invalidateProductCaches(tenantId) {
    await cache.bumpMany(PRODUCT_CACHE_NAMESPACES, tenantId);
}

// @desc    Get all products
// @route   GET /api/products
// @access  Private
exports.getProducts = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);

    const params = {
        page, limit,
        category: req.query.category || null,
        isActive: req.query.isActive,
        lowStock: req.query.lowStock,
        search: req.query.search || null,
        productType: req.query.productType || null,
    };

    const payload = await cache.cached(
        { ns: 'products:list', tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = { tenantId };
            if (req.query.category) query.category = req.query.category;
            if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';
            if (req.query.lowStock === 'true') query.$expr = { $lte: ['$quantity', '$minStockLevel'] };
            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { sku: { $regex: req.query.search, $options: 'i' } },
                    { barcode: { $regex: req.query.search, $options: 'i' } }
                ];
            }
            if (req.query.productType === 'non-serial') {
                const nonSerialCategoryIds = await Category.find({ itemType: { $in: ['non-serial', 'both'] } }).select('_id').lean();
                query.category = { $in: nonSerialCategoryIds.map((c) => c._id) };
            }
            if (req.query.productType === 'serial') {
                const serialCategoryIds = await Category.find({ itemType: { $in: ['serial', 'both'] } }).select('_id').lean();
                query.category = { $in: serialCategoryIds.map((c) => c._id) };
            }

            const [total, products] = await Promise.all([
                Product.countDocuments(query),
                Product.find(query)
                    .populate('category', 'name')
                    .populate('subCategory', 'name')
                    .populate('supplier', 'name contactPerson')
                    .skip(startIndex)
                    .limit(limit)
                    .sort('-createdAt')
                    .lean()
            ]);
            return { total, products, page, pages: Math.ceil(total / limit) };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.products.length,
        total: payload.total,
        page: payload.page,
        pages: payload.pages,
        data: payload.products
    });
});

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Private
exports.getProduct = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const product = await Product.findOne({ _id: req.params.id, tenantId })
        .populate('category', 'name')
        .populate('subCategory', 'name')
        .populate('supplier', 'name contactPerson')
        .populate('brand', 'name');

    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        });
    }

    res.status(200).json({
        success: true,
        data: product
    });
});

// @desc    Full product history by IMEI/serial: origin (purchase), sales, status, timeline
// @route   GET /api/products/serial-history/:serialNumber
// @access  Private
exports.getSerialHistory = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const serialNumber = (req.params.serialNumber || '').trim();
    if (!serialNumber) {
        return res.status(400).json({ success: false, message: 'Serial number is required' });
    }

    // Find purchases containing this serial (exact match only - no regex fallback to avoid false matches)
    // Use exact match to prevent random numbers from matching partial serials
    const serialNormalized = serialNumber.trim();
    let purchasesWithSerial = await Purchase.find({ tenantId, 'items.imeis': serialNormalized })
        .populate('supplier', 'name contactPerson')
        .populate('account', 'name contactPerson contactName')
        .sort('date')
        .lean();
    
    // Verify exact match in items (double-check to prevent partial matches)
    if (purchasesWithSerial.length > 0) {
        purchasesWithSerial = purchasesWithSerial.filter((p) => {
            return (p.items || []).some((item) => {
                const imeis = (item.imeis || []).map((x) => String(x).trim());
                return imeis.includes(serialNormalized);
            });
        });
    }

    const [salesWithSerial, soldRecord, historyEvents] = await Promise.all([
        Sale.find({ tenantId, 'items.serialNumbers': serialNormalized, status: { $ne: 'voided' } })
            .sort('-createdAt')
            .lean(),
        SoldSerial.findOne({ serialNumber: serialNormalized }).populate('saleId', 'customerName reference createdAt status').lean(),
        SerialHistory.find({ serialNumber: serialNormalized }).sort('createdAt').lean()
    ]);

    let origin = null;
    if (purchasesWithSerial.length > 0) {
        const p = purchasesWithSerial[0];
        const item = (p.items || []).find((it) => (it.imeis || []).map((x) => String(x).trim()).includes(serialNormalized));
        if (item) {
            const purchaseNoteRaw = p.note != null ? String(p.note).trim() : '';
            origin = {
                purchaseId: p._id?.toString(),
                itemId: item._id?.toString(),
                purchaseNumber: p.purchaseNumber,
                parcelNumber: p.parcelNumber,
                date: p.date,
                createdAt: p.createdAt,
                supplier: purchasePartyLabel(p),
                currency: p.currency,
                purchaseNote: purchaseNoteRaw || undefined,
                item: {
                    brand: item.brand,
                    brandModel: item.brandModel,
                    grade: item.grade,
                    capacity: item.capacity,
                    colour: item.colour,
                    purchasePrice: item.purchasePrice,
                    salePrice: item.salePrice,
                    name: item.name
                }
            };
        }
    }

    const currentSales = (salesWithSerial || []).map((sale) => {
        const matchingItems = (sale.items || []).filter(
            (item) =>
                item.serialNumbers &&
                item.serialNumbers.some((sn) => String(sn).trim() === serialNormalized)
        );
        return {
            _id: sale._id,
            reference: sale.reference,
            type: sale.type,
            customerName: sale.customerName,
            total: sale.total,
            createdAt: sale.createdAt,
            items: matchingItems.map((i) => ({
                sku: i.sku,
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                serialNumbers: i.serialNumbers
            }))
        };
    });
    // UI "Sales" list: active (non-voided) invoices only. Timeline still in `movements` via SerialHistory.
    const sales = currentSales;

    // Status: ground truth from Purchase + SoldSerial + active Sale — NOT from SerialHistory alone
    // (new parcels often have no history rows yet; old logic wrongly forced "not_in_stock".)
    let status = 'not_in_stock';

    if (!origin) {
        status = 'not_in_stock';
    } else {
        const saleOk = (s) => s && s.status !== 'voided';
        if (soldRecord && saleOk(soldRecord.saleId)) {
            status = soldRecord.status === 'returned' ? 'returned' : 'sold';
        } else if (salesWithSerial && salesWithSerial.length > 0) {
            status = 'sold';
        } else {
            const purchase = await Purchase.findOne({
                _id: origin.purchaseId,
                tenantId,
                'items.imeis': serialNormalized
            })
                .select('status')
                .lean();

            if (!purchase || !purchase.status || purchase.status === 'cancelled') {
                status = 'not_in_stock';
            } else if ((historyEvents || []).some((e) => e.eventType === 'returned_to_supplier')) {
                status = 'not_in_stock';
            } else {
                status = 'in_stock';
            }
        }
    }

    const movements = [];
    if (origin) {
        movements.push({
            type: 'received',
            date: origin.createdAt || origin.date,
            from: origin.supplier || 'Supplier',
            to: 'Stock',
            note: origin.purchaseNumber,
            parcelNumber: origin.parcelNumber,
            purchaseNote: origin.purchaseNote || ''
        });
    }
    // Enrich purchase-return events that lack productName/actorName (e.g. created before we added those fields)
    const returnIdsToEnrich = (historyEvents || [])
        .filter((e) => (e.eventType === 'returned_to_supplier' || e.eventType === 'received_from_repair') && (!e.productName || !e.actorName) && e.referenceId)
        .map((e) => e.referenceId);
    let returnEnrich = {};
    if (returnIdsToEnrich.length > 0) {
        const returns = await PurchaseReturn.find({ tenantId, _id: { $in: returnIdsToEnrich } })
            .populate('purchase')
            .populate('createdBy', 'name')
            .lean();
        const purchaseIds = [...new Set(returns.map((r) => r.purchase && r.purchase._id).filter(Boolean))];
        const purchases = await Purchase.find({ tenantId, _id: { $in: purchaseIds } })
            .populate('supplier', 'name contactPerson')
            .populate('account', 'name contactPerson contactName')
            .lean();
        const purchaseMap = {};
        purchases.forEach((p) => { purchaseMap[p._id.toString()] = p; });
        returns.forEach((r) => {
            const pDoc = r.purchase && purchaseMap[r.purchase._id.toString()];
            const supplierName = pDoc ? (purchasePartyLabel(pDoc) || 'Supplier') : 'Supplier';
            const createdByName = (r.createdBy && r.createdBy.name) ? r.createdBy.name : '';
            const itemNames = {};
            if (r.purchase && r.items) {
                const purchaseDoc = purchaseMap[r.purchase._id.toString()];
                const items = (purchaseDoc && purchaseDoc.items) || [];
                r.items.forEach((line) => {
                    const it = items.find((i) => String(i._id) === String(line.purchaseItemId));
                    const name = it ? ((it.name && String(it.name).trim()) || [it.brand, it.brandModel].filter(Boolean).join(' ').trim() || 'Product') : 'Product';
                    (line.imeisReturned || []).forEach((imei) => { itemNames[String(imei).trim()] = name; });
                });
            }
            returnEnrich[r._id.toString()] = { supplierName, createdByName, itemNames, note: r.note || '' };
        });
    }

    (historyEvents || []).forEach((e) => {
        if (e.eventType === 'sold') {
            movements.push({
                type: 'sale',
                date: e.createdAt,
                to: e.customerName || 'Walk-in',
                reference: e.referenceLabel,
                saleId: e.referenceId
            });
        } else if (e.eventType === 'removed_from_invoice') {
            movements.push({
                type: 'removed_from_invoice',
                date: e.createdAt,
                reference: e.referenceLabel,
                saleId: e.referenceId
            });
        } else if (e.eventType === 'returned') {
            movements.push({
                type: 'returned',
                date: e.createdAt,
                reference: e.referenceLabel,
                salesReturnId: e.referenceId,
                returnDestination: e.returnDestination || ''
            });
        } else if (e.eventType === 'sale_deleted') {
            movements.push({
                type: 'sale_deleted',
                date: e.createdAt,
                reference: e.referenceLabel,
                saleId: e.referenceId
            });
        } else if (e.eventType === 'returned_to_supplier') {
            const refId = e.referenceId && e.referenceId.toString();
            const enriched = returnEnrich[refId];
            const productName = e.productName || (enriched && enriched.itemNames && enriched.itemNames[serialNormalized]) || '';
            const returnReason = e.returnReason || (enriched && enriched.note) || '';
            const returnTo = e.returnTo || (enriched && enriched.supplierName) || 'Supplier';
            const performedBy = e.actorName || (enriched && enriched.createdByName) || '';
            movements.push({
                type: 'returned_to_supplier',
                date: e.createdAt,
                dateTime: e.createdAt ? new Date(e.createdAt).toISOString() : null,
                productName,
                returnReason,
                returnTo,
                performedBy,
                reference: e.referenceLabel,
                purchaseReturnId: e.referenceId,
                returnDestination: e.returnDestination || 'repair'
            });
        } else if (e.eventType === 'received_from_repair') {
            const refId = e.referenceId && e.referenceId.toString();
            const enriched = returnEnrich[refId];
            const productName = e.productName || (enriched && enriched.itemNames && enriched.itemNames[serialNormalized]) || '';
            const returnReason = e.returnReason || (enriched && enriched.note) || '';
            const returnTo = e.returnTo || (enriched && enriched.supplierName) || 'Supplier';
            const performedBy = e.actorName || (enriched && enriched.createdByName) || '';
            movements.push({
                type: 'received_from_repair',
                date: e.createdAt,
                dateTime: e.createdAt ? new Date(e.createdAt).toISOString() : null,
                productName,
                returnReason,
                returnTo,
                performedBy,
                reference: e.referenceLabel,
                purchaseReturnId: e.referenceId,
                note: 'Back in stock'
            });
        }
    });
    movements.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Final validation: if no origin, sales, soldRecord, or historyEvents, status MUST be 'not_in_stock'
    // This is a critical check to prevent random numbers from showing as 'in_stock'
    const hasNoRecords = !origin && (!sales || sales.length === 0) && !soldRecord && (!historyEvents || historyEvents.length === 0);
    if (hasNoRecords) {
        status = 'not_in_stock';
    }
    
    // Additional safety check: if status is somehow still undefined or invalid, default to 'not_in_stock'
    if (!status || (status !== 'in_stock' && status !== 'sold' && status !== 'returned' && status !== 'not_in_stock')) {
        status = 'not_in_stock';
    }
    
    // Debug log (remove in production if needed)
    if (!origin && status !== 'not_in_stock') {
        console.warn(`[getSerialHistory] Serial ${serialNumber} has no origin but status is ${status}. Forcing to 'not_in_stock'.`);
        status = 'not_in_stock';
    }

    // Prevent caching of serial history responses to ensure fresh data
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    
    res.status(200).json({
        success: true,
        serialNumber,
        status, // This will be 'not_in_stock' for random numbers
        origin: origin || null,
        sales: sales || [],
        movements: movements || [],
        data: { serialNumber, status, origin: origin || null, sales: sales || [], movements: movements || [] }
    });
});

// @desc    Get products by barcodes (batch lookup for rate list -> ProductGroupPrice mapping)
// @route   GET /api/products/by-barcodes
// @access  Private
exports.getProductsByBarcodes = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const raw = req.query.barcodes;
    const barcodes = typeof raw === 'string' ? raw.split(',').map((b) => b.trim()).filter(Boolean) : [];
    if (barcodes.length === 0) {
        return res.status(200).json({ success: true, data: [] });
    }
    const products = await Product.find({ barcode: { $in: barcodes }, isActive: true, tenantId })
        .select('_id barcode')
        .lean();
    const data = products.map((p) => ({ _id: p._id.toString(), barcode: p.barcode || '' }));
    res.status(200).json({ success: true, data });
});

// @desc    Get product by barcode
// @route   GET /api/products/barcode/:barcode
// @access  Private
exports.getProductByBarcode = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const product = await Product.findOne({ barcode: req.params.barcode, isActive: true, tenantId })
        .populate('category', 'name')
        .lean();

    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        });
    }

    const pricingGroupId = req.query.pricingGroupId || null;
    if (pricingGroupId) {
        const gp = await ProductGroupPrice.findOne({ tenantId, product: product._id, pricingGroup: pricingGroupId }).lean();
        const resolved = (gp != null && typeof gp.price === 'number' && !Number.isNaN(gp.price)) ? gp.price : (Number(product.sellingPrice) || 0);
        product.sellingPrice = resolved;
    }

    res.status(200).json({
        success: true,
        data: product
    });
});

// @desc    Get group prices for a product
// @route   GET /api/products/:id/group-prices
// @access  Private
exports.getProductGroupPrices = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const product = await Product.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const list = await ProductGroupPrice.find({ tenantId, product: req.params.id })
        .populate('pricingGroup', 'name')
        .lean();
    const data = list.map((gp) => ({
        pricingGroupId: gp.pricingGroup && gp.pricingGroup._id,
        pricingGroupName: gp.pricingGroup && gp.pricingGroup.name,
        price: gp.price
    }));
    res.status(200).json({ success: true, data });
});

// @desc    Set group prices for a product (array of { pricingGroupId, price })
// @route   PUT /api/products/:id/group-prices
// @access  Private
exports.putProductGroupPrices = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const product = await Product.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const items = Array.isArray(req.body.groupPrices) ? req.body.groupPrices : [];
    for (const item of items) {
        const groupId = item.pricingGroupId || item.pricingGroup;
        if (!groupId) continue;
        const price = typeof item.price === 'number' && !Number.isNaN(item.price) && item.price >= 0 ? item.price : null;
        if (price === null) {
            await ProductGroupPrice.deleteOne({ tenantId, product: req.params.id, pricingGroup: groupId });
        } else {
            await ProductGroupPrice.findOneAndUpdate(
                { tenantId, product: req.params.id, pricingGroup: groupId },
                { $set: { price, tenantId, product: req.params.id, pricingGroup: groupId } },
                { upsert: true, new: true }
            );
        }
    }
    const list = await ProductGroupPrice.find({ tenantId, product: req.params.id })
        .populate('pricingGroup', 'name')
        .lean();
    const data = list.map((gp) => ({
        pricingGroupId: gp.pricingGroup && gp.pricingGroup._id,
        pricingGroupName: gp.pricingGroup && gp.pricingGroup.name,
        price: gp.price
    }));
    res.status(200).json({ success: true, data });
});

// @desc    Create product
// @route   POST /api/products
// @access  Private/Admin/Manager
exports.createProduct = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = { ...req.body };
    if (body.tenantId !== undefined) delete body.tenantId;
    if (body.name) body.name = formatProductName(body.name);
    const product = await Product.create({ ...body, tenantId });

    // Create initial inventory record
    if (product.quantity > 0) {
        await Inventory.create({
            product: product._id,
            type: 'in',
            quantity: product.quantity,
            previousQuantity: 0,
            newQuantity: product.quantity,
            reason: 'purchase',
            reference: 'Initial stock',
            createdBy: req.user.id
        });
    }

    await auditService.logFromReq(req, 'Product', product._id, 'CREATE', { after: product.toObject() });
    await activityLogService.logProductEvent(req, 'PRODUCT_CREATED', product);
    await invalidateProductCaches(tenantId);

    res.status(201).json({
        success: true,
        message: 'Product created successfully',
        data: product
    });
});

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private/Admin/Manager
exports.updateProduct = asyncHandler(async (req, res) => {
    let product = await Product.findById(req.params.id);

    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        });
    }

    // Don't update quantity through this endpoint
    const beforeSnapshot = product.toObject();
    delete req.body.quantity;
    if (req.body.name) req.body.name = formatProductName(req.body.name);

    product = await Product.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });

    await auditService.logFromReq(req, 'Product', product._id, 'UPDATE', {
        before: beforeSnapshot,
        after: product.toObject()
    });
    await activityLogService.logProductEvent(req, 'PRODUCT_UPDATED', product, { before: beforeSnapshot });
    await invalidateProductCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Product updated successfully',
        data: product
    });
});

// @desc    Update product stock (Product.quantity, optional StockBalance + StockMove when locationId provided)
// @route   PUT /api/products/:id/stock
// @access  Private/stock.adjust
exports.updateStock = asyncHandler(async (req, res) => {
    const { quantity, type, reason, notes, locationId } = req.body;
    const qty = typeof quantity === 'string' ? parseFloat(quantity) : Number(quantity);
    if (isNaN(qty) || qty < 0) {
        return res.status(400).json({ success: false, message: 'Quantity must be a non-negative number' });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        });
    }

    const previousQuantity = product.quantity;
    let newQuantity;

    if (type === 'in') {
        newQuantity = previousQuantity + qty;
    } else if (type === 'out') {
        newQuantity = previousQuantity - qty;
        if (newQuantity < 0) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient stock'
            });
        }
    } else {
        newQuantity = qty; // adjustment = set exact
    }

    product.quantity = newQuantity;
    await product.save();

    const delta = newQuantity - previousQuantity;

    if (locationId) {
        const Location = require('../models/Location');
        const loc = await Location.findById(locationId);
        if (!loc) {
            return res.status(400).json({ success: false, message: 'Invalid location' });
        }
        let balance = await StockBalance.findOne({ productId: product._id, locationId });
        const prevBalance = balance ? balance.quantity : 0;
        let newBalance;
        if (type === 'in') {
            newBalance = prevBalance + qty;
        } else if (type === 'out') {
            newBalance = Math.max(0, prevBalance - qty);
            if (prevBalance - qty < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient stock at this location'
                });
            }
        } else {
            newBalance = qty;
        }
        if (!balance) {
            balance = await StockBalance.create({
                productId: product._id,
                locationId,
                quantity: newBalance
            });
        } else {
            balance.quantity = newBalance;
            await balance.save();
        }
        const moveType = type === 'in' ? 'in' : type === 'out' ? 'out' : delta >= 0 ? 'adjust_in' : 'adjust_out';
        const moveQty = type === 'adjustment' ? Math.abs(delta) : qty;
        if (moveQty > 0) {
            await StockMove.create({
                type: moveType,
                locationId,
                productId: product._id,
                quantity: moveQty
            });
        }
    }

    // Legacy inventory record (reason must be one of: purchase, sale, return, damage, adjustment, transfer)
    const validReasons = ['purchase', 'sale', 'return', 'damage', 'adjustment', 'transfer'];
    const inventoryReason = (reason && validReasons.includes(reason)) ? reason : 'adjustment';

    await Inventory.create({
        product: product._id,
        type: type === 'adjustment' ? 'adjustment' : type,
        quantity: Math.abs(delta),
        previousQuantity,
        newQuantity,
        reason: inventoryReason,
        notes,
        createdBy: req.user.id
    });

    await auditService.logFromReq(req, 'Product', product._id, 'ADJUSTMENT', {
        before: { quantity: previousQuantity },
        after: { quantity: newQuantity },
        reason: reason || type,
        notes
    });
    await activityLogService.logProductEvent(req, 'STOCK_ADJUSTED', product, {
        before: { quantity: previousQuantity },
        after: { quantity: newQuantity },
        diff: { quantity: delta },
        meta: { reason: reason || type, notes }
    });
    await invalidateProductCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Stock updated successfully',
        data: product
    });
});

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private/Admin
exports.deleteProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);

    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        });
    }

    const beforeSnapshot = product.toObject();
    await product.deleteOne();

    await auditService.logFromReq(req, 'Product', req.params.id, 'DELETE', { before: beforeSnapshot });
    await activityLogService.logFromReq(req, {
        action: 'PRODUCT_DELETED',
        entityType: 'Product',
        entityId: req.params.id,
        productId: req.params.id,
        success: true,
        message: 'Product deleted',
        beforeJson: beforeSnapshot
    });
    await invalidateProductCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Product deleted successfully'
    });
});

// @desc    Get low stock products (legacy: uses Product.quantity and minStockLevel)
// @route   GET /api/products/low-stock
// @access  Private
exports.getLowStockProducts = asyncHandler(async (req, res) => {
    const products = await Product.find({
        isActive: true,
        $expr: { $lte: ['$quantity', '$minStockLevel'] }
    })
        .populate('category', 'name');

    res.status(200).json({
        success: true,
        count: products.length,
        data: products
    });
});

// @desc    Update product low-stock threshold (per-product override). null = reset to global default.
// @route   PUT /api/products/:id/low-stock-threshold
// @access  Private (product.edit)
exports.updateProductLowStockThreshold = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id).select('name sku lowStockThreshold');
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const oldVal = product.lowStockThreshold;
    let newVal = req.body.lowStockThreshold;
    if (newVal === undefined) {
        return res.status(400).json({ success: false, message: 'lowStockThreshold is required (use null to reset to default)' });
    }
    if (newVal !== null) {
        const parsed = parseInt(newVal, 10);
        if (isNaN(parsed) || parsed < 0) {
            return res.status(400).json({ success: false, message: 'lowStockThreshold must be null or a non-negative number' });
        }
        newVal = parsed;
    }
    product.lowStockThreshold = newVal;
    await product.save();

    await activityLogService.logFromReq(req, {
        action: 'LOW_STOCK_THRESHOLD_PRODUCT_UPDATED',
        entityType: 'Product',
        entityId: product._id,
        productId: product._id,
        success: true,
        message: `Low stock threshold for ${product.name || product.sku} set to ${newVal === null ? 'default' : newVal}`,
        diffJson: { productId: product._id, old: oldVal, new: newVal }
    });

    res.status(200).json({
        success: true,
        message: 'Low stock threshold updated',
        data: { _id: product._id, lowStockThreshold: product.lowStockThreshold }
    });
});

// @desc    Get expired products
// @route   GET /api/products/expired
// @access  Private
exports.getExpiredProducts = asyncHandler(async (req, res) => {
    const now = new Date();
    const products = await Product.find({
        isActive: true,
        expiryDate: { $ne: null, $lt: now }
    })
        .populate('category', 'name')
        .sort('expiryDate');

    res.status(200).json({
        success: true,
        count: products.length,
        data: products
    });
});

// @desc    Get expiring soon products (within 30 days)
// @route   GET /api/products/expiring-soon
// @access  Private
exports.getExpiringSoonProducts = asyncHandler(async (req, res) => {
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const products = await Product.find({
        isActive: true,
        expiryDate: { $ne: null, $gte: now, $lte: thirtyDaysFromNow }
    })
        .populate('category', 'name')
        .sort('expiryDate');

    res.status(200).json({
        success: true,
        count: products.length,
        data: products
    });
});
