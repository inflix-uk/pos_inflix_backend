const SalesReturn = require('../models/SalesReturn');
const LedgerEntry = require('../models/LedgerEntry');
const Customer = require('../models/Customer');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const Product = require('../models/Product');
const GeneralSettings = require('../models/GeneralSettings');
const { verifyAdminTotpCode } = require('./generalSettingsController');
const asyncHandler = require('../middleware/asyncHandler');
const auditService = require('../services/auditService');
const transactionService = require('../services/transactionService');
const salesTransactionService = require('../services/salesTransactionService');
const activityLogService = require('../services/activityLogService');
const purchaseReturnService = require('../services/purchaseReturnService');
const serialIndexService = require('../services/serialIndexService');
const metricsService = require('../services/metricsService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const SALES_RETURN_CACHE_NAMESPACES = ['salesReturns:list'];
async function invalidateSalesReturnCaches(tenantId) {
    await cache.bumpMany(SALES_RETURN_CACHE_NAMESPACES, tenantId);
    await cache.bumpNs('sales:list', tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    await cache.bumpNs('customers:list', tenantId);
    // Inventory products page reads from SWR caches in purchaseController; returns put stock back, so clear them.
    const purchaseCtrl = require('./purchaseController');
    purchaseCtrl.invalidateStockPurchasesCache?.(tenantId);
    purchaseCtrl.invalidateStockSerialSetCache?.(tenantId);
}

const DEST_TO_SERIAL = { restock: 'in_stock', damaged: 'damaged', refurb: 'refurb', return_to_supplier: 'return_to_supplier' };

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// @desc    Get all sales returns
// @route   GET /api/sales-returns
// @access  Private
exports.getSalesReturns = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);
    const mongoose = require('mongoose');

    const userScopeForCache = getUserLocationScope(req.user);
    const cacheParams = {
        page, limit,
        userScope: Array.isArray(userScopeForCache) ? [...userScopeForCache].sort() : null,
        search: req.query.search || null,
        status: req.query.status || null,
        paymentStatus: req.query.paymentStatus || null,
        customer: req.query.customer || null,
    };

    const payload = await cache.cached(
        { ns: 'salesReturns:list', tenantId, params: cacheParams, ttlSec: TTL.TRANSACTIONAL },
        async () => {

    const query = { tenantId };
    
    // Phase 3: Location-based access control
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        // Non-admin: filter by assigned locations
        query.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    // Admin or empty assignedLocationIds: no location filter (see all locations)
    if (req.query.search) {
        const search = req.query.search.trim();
        query.$or = [
            { reference: { $regex: search, $options: 'i' } },
            { linkedInvoiceRef: { $regex: search, $options: 'i' } },
            { customerName: { $regex: search, $options: 'i' } },
            { 'items.product': { $regex: search, $options: 'i' } },
            { 'items.serialNumbers': { $regex: search, $options: 'i' } },
        ];
    }
    if (req.query.status && req.query.status !== 'All') query.status = req.query.status;
    if (req.query.paymentStatus && req.query.paymentStatus !== 'All') query.paymentStatus = req.query.paymentStatus;
    if (req.query.customer && req.query.customer !== 'All') query.customerName = req.query.customer;

    const [total, list] = await Promise.all([
        SalesReturn.countDocuments(query),
        SalesReturn.find(query)
            .sort({ date: -1, createdAt: -1 })
            .skip(startIndex)
            .limit(limit)
            .lean()
    ]);

    const data = list.map((doc) => ({
        id: doc._id.toString(),
        _id: doc._id.toString(),
        customer: {
            name: (doc.customerName != null && doc.customerName !== '') ? String(doc.customerName) : (doc.customer?.name || ''),
            avatar: 'user',
            color: 'bg-gray-100',
        },
        date: doc.date ? new Date(doc.date).toISOString().slice(0, 10) : '',
        reference: doc.reference || '',
        linkedInvoiceRef: doc.linkedInvoiceRef || '',
        status: doc.status || 'Pending',
        paymentStatus: doc.paymentStatus || 'Unpaid',
        total: round2(doc.total || 0),
        paid: round2(doc.paid || 0),
        due: round2(doc.due || 0),
        orderTax: round2(doc.orderTax || 0),
        discount: round2(doc.discount || 0),
        shipping: round2(doc.shipping || 0),
        grandTotal: round2(doc.grandTotal || 0),
        items: (doc.items || []).map((it, idx) => ({
            id: it._id ? it._id.toString() : `item-${idx}`,
            product: it.product || '',
            sku: it.sku || '',
            netUnitPrice: round2(it.netUnitPrice || 0),
            stock: it.stock || 0,
            quantity: it.quantity || 0,
            discount: it.discount || 0,
            taxPercent: it.taxPercent || 0,
            subtotal: round2(it.subtotal || 0),
            serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers : [],
            returnDestination: it.returnDestination || 'restock',
        })),
    }));

            return { total, data };
        }
    );

    res.status(200).json({
        success: true,
        data: payload.data,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit) || 1,
        count: payload.data.length,
    });
});

// @desc    Get single sales return
// @route   GET /api/sales-returns/:id
// @access  Private
exports.getSalesReturnById = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await SalesReturn.findOne({ _id: req.params.id, tenantId }).lean();
    if (!doc) {
        return res.status(404).json({ success: false, message: 'Sales return not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this return's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && doc.locationId) {
        const returnLocationId = doc.locationId.toString ? doc.locationId.toString() : String(doc.locationId);
        if (!userScope.includes(returnLocationId)) {
            return res.status(404).json({ success: false, message: 'Sales return not found' });
        }
    }
    const out = {
        id: doc._id.toString(),
        customer: {
            name: (doc.customerName != null && doc.customerName !== '') ? String(doc.customerName) : (doc.customer?.name || ''),
            avatar: 'user',
            color: 'bg-gray-100',
        },
        date: doc.date ? new Date(doc.date).toISOString().slice(0, 10) : '',
        reference: doc.reference || '',
        linkedInvoiceRef: doc.linkedInvoiceRef || '',
        status: doc.status || 'Pending',
        paymentStatus: doc.paymentStatus || 'Unpaid',
        total: round2(doc.total || 0),
        paid: round2(doc.paid || 0),
        due: round2(doc.due || 0),
        orderTax: round2(doc.orderTax || 0),
        discount: round2(doc.discount || 0),
        shipping: round2(doc.shipping || 0),
        grandTotal: round2(doc.grandTotal || 0),
        items: (doc.items || []).map((it, idx) => ({
            id: it._id ? it._id.toString() : `item-${idx}`,
            product: it.product || '',
            sku: it.sku || '',
            netUnitPrice: round2(it.netUnitPrice || 0),
            stock: it.stock || 0,
            quantity: it.quantity || 0,
            discount: it.discount || 0,
            taxPercent: it.taxPercent || 0,
            subtotal: round2(it.subtotal || 0),
            serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers : [],
            returnDestination: it.returnDestination || 'restock',
        })),
    };
    res.status(200).json({ success: true, data: out });
});

// @desc    Create sales return (atomic transaction; double-return safe via findOneAndUpdate per serial)
// @route   POST /api/sales-returns
// @access  Private
exports.createSalesReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = { ...req.body };
    if (body.tenantId !== undefined) delete body.tenantId;
    body.tenantId = tenantId;

    console.log('[POST /api/sales-returns] incoming body:', JSON.stringify({
        returnType: body.returnType,
        customerName: body.customerName,
        customerId: body.customerId,
        linkedInvoiceRef: body.linkedInvoiceRef,
        refundMethod: body.refundMethod,
        refundAccountId: body.refundAccountId,
        adminOtpCode: body.adminOtpCode ? `***${String(body.adminOtpCode).slice(-2)}` : undefined,
        orderTax: body.orderTax,
        discount: body.discount,
        shipping: body.shipping,
        paid: body.paid,
        total: body.total,
        grandTotal: body.grandTotal,
        itemCount: Array.isArray(body.items) ? body.items.length : 0,
        items: Array.isArray(body.items) ? body.items.map(it => ({
            product: it.product,
            sku: it.sku,
            quantity: it.quantity,
            netUnitPrice: it.netUnitPrice,
            subtotal: it.subtotal,
            returnDestination: it.returnDestination,
            serialCount: Array.isArray(it.serialNumbers) ? it.serialNumbers.length : 0
        })) : []
    }, null, 2));
    
    // Phase 3: Location-based access control - validate locationId if provided
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && body.locationId) {
        const locationIdStr = body.locationId.toString ? body.locationId.toString() : String(body.locationId);
        if (!userScope.includes(locationIdStr)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to create returns for this location'
            });
        }
    } else if (!body.locationId && req.user?.defaultLocationId) {
        // Use defaultLocationId if available and in scope (or admin)
        body.locationId = req.user.defaultLocationId;
    }
    
    const customerName = (body.customerName || body.customer?.name || '').trim();
    if (!customerName) {
        return res.status(400).json({ success: false, message: 'Customer name is required' });
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one item is required' });
    }
    if (body.returnType === 'refund') {
        if (!body.refundAccountId) {
            return res.status(400).json({ success: false, message: 'Refund requires a payment account (refundAccountId) to deduct from' });
        }
        if (!body.refundMethod || !['cash', 'card', 'bank'].includes(body.refundMethod)) {
            return res.status(400).json({ success: false, message: 'Refund requires refundMethod: cash, card, or bank' });
        }
    }

    // High-value return gate: above the configured threshold the admin's Google Authenticator code is required
    // for ANY sales return (refund or store credit), regardless of which UI path created it.
    {
        const itemsTotal = body.items.reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
        const orderTax = Number(body.orderTax) || 0;
        const discount = Number(body.discount) || 0;
        const shipping = Number(body.shipping) || 0;
        const expectedGrandTotal = Math.round((itemsTotal + orderTax - discount + shipping) * 100) / 100;

        const settings = await GeneralSettings.getSettings();
        const threshold = typeof settings.refundOtpThreshold === 'number' ? settings.refundOtpThreshold : 50;
        if (expectedGrandTotal > threshold) {
            console.log(`[sales-return OTP gate] grandTotal=${expectedGrandTotal} > threshold=${threshold} — checking admin OTP`);
            if (!settings.adminTotpEnabled || !settings.adminTotpSecret) {
                return res.status(409).json({
                    success: false,
                    code: 'ADMIN_2FA_NOT_SETUP',
                    message: `Returns over ${threshold} require admin Google Authenticator. Ask the admin to enable it in Settings > General.`
                });
            }
            const otpCode = body.adminOtpCode || req.headers['x-admin-otp'];
            if (!otpCode) {
                return res.status(401).json({
                    success: false,
                    code: 'ADMIN_OTP_REQUIRED',
                    message: `Returns over ${threshold} require an admin Google Authenticator code`,
                    refundOtpThreshold: threshold
                });
            }
            if (!verifyAdminTotpCode(settings.adminTotpSecret, otpCode)) {
                return res.status(401).json({
                    success: false,
                    code: 'ADMIN_OTP_INVALID',
                    message: 'Invalid admin code — ask the admin for the current 6-digit code'
                });
            }
        }
    }

    const auditCtx = activityLogService.contextFromReq(req);
    let result;
    try {
        result = await transactionService.runWithTransaction(async (session) => {
            const returnResult = await salesTransactionService.createSalesReturnInTransaction(session, body, {
                userId: req.user?.id
            });
            const sr = returnResult.salesReturn;
            const ref = (sr.reference || sr._id).toString();
            await activityLogService.log({
                actorUserId: auditCtx.actorUserId,
                actorName: auditCtx.actorName,
                actorRole: auditCtx.actorRole,
                action: body.returnType === 'refund' ? 'REFUND_ISSUED' : body.returnType === 'store_credit' ? 'STORE_CREDIT' : 'CREATE_RETURN',
                entityType: 'SalesReturn',
                entityId: sr._id,
                invoiceNo: (sr.linkedInvoiceRef || sr.reference || '').trim(),
                success: true,
                message: `Return created ${ref}`,
                amount: returnResult.doc.grandTotal,
                source: auditCtx.source,
                ipAddress: auditCtx.ipAddress,
                userAgent: auditCtx.userAgent,
                afterJson: returnResult.doc,
                metaJson: { returnType: body.returnType },
                session
            });
            return returnResult;
        });
    } catch (err) {
        const msg = err.message || 'Return creation failed';
        if (msg.includes('already returned') || msg.includes('cannot be returned')) {
            return res.status(400).json({ success: false, message: msg });
        }
        if (err.message && err.message.includes('Transaction')) {
            return res.status(503).json({
                success: false,
                message: 'Database transactions are not available. Ensure MongoDB is running as a replica set.'
            });
        }
        throw err;
    }

    const { salesReturn, doc } = result;
    await auditService.logFromReq(req, 'SalesReturn', salesReturn._id, 'CREATE', { after: doc });
    // Activity log already written inside transaction

    metricsService.incrementReturnCreated(
      tenantId,
      doc.locationId || null,
      doc.grandTotal,
      doc.occurredAt || doc.createdAt
    ).catch(() => {});

    for (const it of doc.items || []) {
        const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [];
        const status = it.returnDestination === 'return_to_supplier' ? 'returned_to_supplier' : 'in_stock';
        for (const serial of serials) {
            serialIndexService.upsertSerialIndex(tenantId, { serial, status }).catch(() => {});
        }
    }

    // When any item was "return to supplier", serials were added back to purchase in the transaction; now create purchase return(s)
    const returnRef = doc.reference || doc._id.toString();
    const byPurchase = {};
    for (const it of doc.items || []) {
        if (it.returnDestination !== 'return_to_supplier') continue;
        const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [];
        if (serials.length === 0) continue;
        const sku = (it.sku || '').trim();
        if (!sku) continue;
        const dashIdx = sku.indexOf('-');
        if (dashIdx <= 0) continue;
        const purchaseId = sku.slice(0, dashIdx);
        const purchaseItemId = sku.slice(dashIdx + 1);
        if (!byPurchase[purchaseId]) byPurchase[purchaseId] = {};
        if (!byPurchase[purchaseId][purchaseItemId]) byPurchase[purchaseId][purchaseItemId] = [];
        byPurchase[purchaseId][purchaseItemId] = byPurchase[purchaseId][purchaseItemId].concat(serials);
    }
    const userId = req.user && req.user.id ? req.user.id : null;
    const actorName = (req.user && req.user.name) ? String(req.user.name) : '';
    for (const purchaseId of Object.keys(byPurchase)) {
        const items = [];
        for (const [purchaseItemId, serials] of Object.entries(byPurchase[purchaseId])) {
            const imeisReturned = [...new Set(serials.map((s) => String(s).trim()).filter(Boolean))];
            if (imeisReturned.length > 0) {
                items.push({ purchaseItemId, imeisReturned });
            }
        }
        if (items.length > 0 && userId) {
            try {
                await purchaseReturnService.createPurchaseReturn(
                    userId,
                    {
                        purchaseId,
                        note: `From sales return ${returnRef}`,
                        items
                    },
                    { actorName, req }
                );
            } catch (e) {
                // Log but do not fail the response; sales return already created
                console.error('Auto create purchase return from sales return failed:', e.message);
            }
        }
    }

    await invalidateSalesReturnCaches(tenantId);

    res.status(201).json({
        success: true,
        message: 'Sales return created',
        data: {
            id: doc._id.toString(),
            customer: { name: (doc.customerName != null && doc.customerName !== '') ? String(doc.customerName) : '', avatar: 'user', color: 'bg-gray-100' },
            date: doc.date ? new Date(doc.date).toISOString().slice(0, 10) : '',
            reference: doc.reference || '',
            linkedInvoiceRef: doc.linkedInvoiceRef || '',
            status: doc.status,
            paymentStatus: doc.paymentStatus,
            total: round2(doc.total),
            paid: round2(doc.paid),
            due: round2(doc.due),
            orderTax: round2(doc.orderTax),
            discount: round2(doc.discount),
            shipping: round2(doc.shipping),
            grandTotal: round2(doc.grandTotal),
            items: (doc.items || []).map((it, idx) => ({
                id: it._id ? it._id.toString() : `item-${idx}`,
                product: it.product,
                sku: it.sku || '',
                netUnitPrice: round2(it.netUnitPrice),
                stock: it.stock,
                quantity: it.quantity,
                discount: it.discount,
                taxPercent: it.taxPercent,
                subtotal: round2(it.subtotal),
                serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers : [],
                returnDestination: it.returnDestination || 'restock',
            })),
        },
    });
});

// @desc    Update sales return
// @route   PUT /api/sales-returns/:id
// @access  Private
exports.updateSalesReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const salesReturn = await SalesReturn.findOne({ _id: req.params.id, tenantId });
    if (!salesReturn) {
        return res.status(404).json({ success: false, message: 'Sales return not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this return's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && salesReturn.locationId) {
        const returnLocationId = salesReturn.locationId.toString ? salesReturn.locationId.toString() : String(salesReturn.locationId);
        if (!userScope.includes(returnLocationId)) {
            return res.status(404).json({ success: false, message: 'Sales return not found' });
        }
    }
    
    // Phase 3: If update includes locationId, validate it's in allowed locations
    if (req.body.locationId !== undefined) {
        const newLocationId = req.body.locationId;
        if (userScope && userScope.length > 0 && newLocationId) {
            const newLocationIdStr = newLocationId.toString ? newLocationId.toString() : String(newLocationId);
            if (!userScope.includes(newLocationIdStr)) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to assign returns to this location'
                });
            }
        }
    }
    
    const beforeSnapshot = salesReturn.toObject();
    const body = req.body;
    const customerName = (body.customerName || (body.customer && body.customer.name) || salesReturn.customerName || '').trim();
    salesReturn.customerName = customerName || salesReturn.customerName;
    if (body.date) salesReturn.date = new Date(body.date);
    if (body.reference !== undefined) salesReturn.reference = body.reference;
    if (body.linkedInvoiceRef !== undefined) salesReturn.linkedInvoiceRef = body.linkedInvoiceRef ? String(body.linkedInvoiceRef).trim() : '';
    if (body.status) salesReturn.status = body.status;
    if (body.paymentStatus) salesReturn.paymentStatus = body.paymentStatus;

    if (body.items && Array.isArray(body.items) && body.items.length > 0) {
        salesReturn.items = body.items.map((it) => {
            const dest = ['restock', 'damaged', 'refurb', 'return_to_supplier'].includes(it.returnDestination) ? it.returnDestination : 'restock';
            return {
                product: it.product || '',
                sku: (it.sku || '').trim(),
                netUnitPrice: round2(Number(it.netUnitPrice) || 0),
                stock: Number(it.stock) || 0,
                quantity: Number(it.quantity) || 1,
                discount: round2(Number(it.discount) || 0),
                taxPercent: round2(Number(it.taxPercent) || 0),
                subtotal: round2(Number(it.subtotal) || 0),
                serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [],
                returnDestination: dest,
            };
        });
    }

    const total = round2(salesReturn.items.reduce((s, i) => s + i.subtotal, 0));
    salesReturn.orderTax = round2(Number(body.orderTax) ?? salesReturn.orderTax);
    salesReturn.discount = round2(Number(body.discount) ?? salesReturn.discount);
    salesReturn.shipping = round2(Number(body.shipping) ?? salesReturn.shipping);
    salesReturn.total = total;
    salesReturn.grandTotal = round2(total + salesReturn.orderTax - salesReturn.discount + salesReturn.shipping);
    salesReturn.paid = round2(Number(body.paid) ?? salesReturn.paid);
    salesReturn.due = round2(salesReturn.grandTotal - salesReturn.paid);

    await salesReturn.save();
    const doc = salesReturn.toObject();
    await auditService.logFromReq(req, 'SalesReturn', salesReturn._id, 'UPDATE', {
        before: beforeSnapshot,
        after: doc
    });
    await invalidateSalesReturnCaches(tenantId);
    res.status(200).json({
        success: true,
        message: 'Sales return updated',
        data: {
            id: doc._id.toString(),
            customer: { name: (doc.customerName != null && doc.customerName !== '') ? String(doc.customerName) : '', avatar: 'user', color: 'bg-gray-100' },
            date: doc.date ? new Date(doc.date).toISOString().slice(0, 10) : '',
            reference: doc.reference || '',
            linkedInvoiceRef: doc.linkedInvoiceRef || '',
            status: doc.status,
            paymentStatus: doc.paymentStatus,
            total: round2(doc.total),
            paid: round2(doc.paid),
            due: round2(doc.due),
            orderTax: round2(doc.orderTax),
            discount: round2(doc.discount),
            shipping: round2(doc.shipping),
            grandTotal: round2(doc.grandTotal),
            items: (doc.items || []).map((it, idx) => ({
                id: it._id ? it._id.toString() : `item-${idx}`,
                product: it.product,
                sku: it.sku || '',
                netUnitPrice: round2(it.netUnitPrice),
                stock: it.stock,
                quantity: it.quantity,
                discount: it.discount,
                taxPercent: it.taxPercent,
                subtotal: round2(it.subtotal),
                serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers : [],
                returnDestination: it.returnDestination || 'restock',
            })),
        },
    });
});

// @desc    Delete sales return
// @route   DELETE /api/sales-returns/:id
// @access  Private
exports.deleteSalesReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const salesReturn = await SalesReturn.findOne({ _id: req.params.id, tenantId });
    if (!salesReturn) {
        return res.status(404).json({ success: false, message: 'Sales return not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this return's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && salesReturn.locationId) {
        const returnLocationId = salesReturn.locationId.toString ? salesReturn.locationId.toString() : String(salesReturn.locationId);
        if (!userScope.includes(returnLocationId)) {
            return res.status(404).json({ success: false, message: 'Sales return not found' });
        }
    }
    const beforeSnapshot = salesReturn.toObject();
    await salesReturn.deleteOne();
    await auditService.logFromReq(req, 'SalesReturn', req.params.id, 'DELETE', { before: beforeSnapshot });
    await activityLogService.logFromReq(req, {
        action: 'DELETE_RETURN',
        entityType: 'SalesReturn',
        entityId: req.params.id,
        invoiceNo: (beforeSnapshot.linkedInvoiceRef || beforeSnapshot.reference || '').trim(),
        success: true,
        message: `Return deleted ${beforeSnapshot.reference || req.params.id}`,
        beforeJson: beforeSnapshot
    });
    await invalidateSalesReturnCaches(tenantId);
    res.status(200).json({ success: true, message: 'Sales return deleted' });
});
