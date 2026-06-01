const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Purchase = require('../models/Purchase');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const SalesReturn = require('../models/SalesReturn');
const Customer = require('../models/Customer');
const GeneralSettings = require('../models/GeneralSettings');
const LedgerEntry = require('../models/LedgerEntry');
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const asyncHandler = require('../middleware/asyncHandler');
const auditService = require('../services/auditService');
const transactionService = require('../services/transactionService');
const salesTransactionService = require('../services/salesTransactionService');
const activityLogService = require('../services/activityLogService');
const serialIndexService = require('../services/serialIndexService');
const stockItemService = require('../services/stockItemService');
const metricsService = require('../services/metricsService');
const {
    legacyFindInStockSerials,
    invalidateStockPurchasesCache,
    invalidateStockSerialSetCache,
} = require('./purchaseController');
const { getTenantIdFromReq } = require('../middleware/auth');
const { findActiveSoldSerialsAmong } = require('../utils/activeSoldSerialQueries');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const {
    normalizePaymentBreakdown,
    computeRemainingAmountDue,
    computeWholesaleTotalOwing,
} = require('../utils/wholesalePaymentAmounts');

const SALES_CACHE_NAMESPACES = ['sales:list', 'sales:soldSerials'];
async function invalidateSalesCaches(tenantId) {
    await cache.bumpMany(SALES_CACHE_NAMESPACES, tenantId);
    // Inventory products page reads from SWR caches in purchaseController; without these,
    // the non-serial qty stays stale (up to maxStaleMs) even though Purchase.items.quantity was decremented.
    invalidateStockPurchasesCache?.(tenantId);
    invalidateStockSerialSetCache?.(tenantId);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const Supplier = require('../models/Supplier');

/** Resolve customer or supplier account used on wholesale sales. */
async function resolveWholesaleSaleAccount(accountId, tenantId) {
    if (!accountId) return null;
    const c = await Customer.findOne({ _id: accountId, tenantId }).select('_id name').lean();
    if (c) return { id: c._id, name: c.name, accountModel: 'Customer', hasCustomerLedger: true };
    const s = await Supplier.findOne({ _id: accountId, tenantId }).select('_id name').lean();
    if (s) return { id: s._id, name: s.name, accountModel: 'Supplier', hasCustomerLedger: false };
    return null;
}

/** Apply or reverse wholesale sale customer ledger (+balance / sale + payment_in rows). sign: 1 apply, -1 reverse. */
async function postWholesaleCustomerLedgerForSale(sale, accountId, accountModel, userId, sign) {
    if (!accountId || accountModel !== 'Customer') return;
    const orderTotal = round2(Number(sale.total) || 0);
    const discount = round2(Number(sale.discount) || 0);
    const netDue = round2(orderTotal - discount);
    const p = sale.payments || {};
    const paidNow = round2(
        (Number(p.cash) || 0) + (Number(p.card) || 0) + (Number(p.bank) || 0)
    );
    const balanceChange = round2(sign * (netDue - paidNow));
    const refLabel = sale.reference || `Sale ${sale._id}`;
    const now = new Date();
    const labelSuffix = sign < 0 ? 'Customer changed (removed)' : 'Customer changed (assigned)';

    await Customer.findByIdAndUpdate(accountId, { $inc: { balance: balanceChange } });

    if (netDue > 0) {
        await LedgerEntry.create({
            accountType: 'customer',
            accountId,
            accountModel: 'Customer',
            type: 'sale',
            amount: round2(sign * netDue),
            referenceId: sale._id,
            referenceLabel: `${labelSuffix} - ${refLabel}`,
            date: now,
            occurredAt: now,
            createdBy: userId
        });
    }
    const cashAmt = round2(Number(p.cash) || 0);
    const cardAmt = round2(Number(p.card) || 0);
    const bankAmt = round2(Number(p.bank) || 0);
    if (cashAmt > 0) {
        await LedgerEntry.create({
            accountType: 'customer',
            accountId,
            accountModel: 'Customer',
            type: 'payment_in',
            amount: round2(sign * -cashAmt),
            referenceId: sale._id,
            referenceLabel: `${refLabel} payment`,
            date: now,
            occurredAt: now,
            paymentMethod: 'cash',
            createdBy: userId
        });
    }
    if (cardAmt > 0) {
        await LedgerEntry.create({
            accountType: 'customer',
            accountId,
            accountModel: 'Customer',
            type: 'payment_in',
            amount: round2(sign * -cardAmt),
            referenceId: sale._id,
            referenceLabel: `${refLabel} payment`,
            date: now,
            occurredAt: now,
            paymentMethod: 'card',
            createdBy: userId
        });
    }
    if (bankAmt > 0) {
        await LedgerEntry.create({
            accountType: 'customer',
            accountId,
            accountModel: 'Customer',
            type: 'payment_in',
            amount: round2(sign * -bankAmt),
            referenceId: sale._id,
            referenceLabel: `${refLabel} payment`,
            date: now,
            occurredAt: now,
            paymentMethod: 'bank',
            createdBy: userId
        });
    }
}

/** Safe substring search for MongoDB $regex */
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** After void/edit removal: sync Redis + SerialIndex so POS does not keep showing "already sold". */
async function refreshSerialIndexForSerials(tenantId, serials) {
    const normalized = [...new Set(serials.map((s) => serialIndexService.normalizeSerial(s)).filter(Boolean))];
    if (normalized.length === 0) return;
    const tid = tenantId || 'default';
    try {
        const legacyResults = await legacyFindInStockSerials(normalized, tid);
        for (const r of legacyResults) {
            serialIndexService.upsertFromResult(tid, r).catch(() => {});
        }
    } catch {
        for (const s of normalized) {
            serialIndexService.invalidateSerial(tid, s).catch(() => {});
        }
    }
}

// Rigid inventory: (1) No serial sold twice — validated before create. (2) Every sold serial recorded in SoldSerial. (3) Product.quantity decremented per SKU. (4) Non-serial purchase item quantity decremented (may go negative on oversell).

// Decrement product quantity by sale items (so inventory count reflects sold units, including serialized)
async function decrementProductQuantities(items) {
    for (const item of items) {
        const qty = Math.max(0, Number(item.quantity) || 0);
        if (qty === 0) continue;
        const product = await Product.findOne({ sku: item.sku });
        if (!product) continue;
        const newQty = Math.max(0, (product.quantity || 0) - qty);
        await Product.updateOne({ sku: item.sku }, { $set: { quantity: newQty } });
    }
}

// Decrement purchase item quantity for non-serial items (sku format: purchaseId-itemId-no-imei). Allows negative (oversold).
async function decrementPurchaseItemQuantities(items) {
    const suffix = '-no-imei';
    for (const item of items) {
        const soldQty = Math.max(0, Number(item.quantity) || 0);
        if (soldQty === 0 || !item.sku || typeof item.sku !== 'string') continue;
        if (!item.sku.endsWith(suffix)) continue;
        const prefix = item.sku.slice(0, -suffix.length);
        const firstDash = prefix.indexOf('-');
        if (firstDash <= 0) continue;
        const purchaseId = prefix.slice(0, firstDash);
        const itemId = prefix.slice(firstDash + 1);
        const purchase = await Purchase.findById(purchaseId);
        if (!purchase || !purchase.items || !Array.isArray(purchase.items)) continue;
        const subdoc = purchase.items.find((i) => String(i._id) === String(itemId));
        if (!subdoc || !subdoc.isOtherItem) continue;
        const current = Number(subdoc.quantity) || 0;
        subdoc.quantity = current - soldQty;
        await purchase.save();
    }
}

// Increment product quantities (return to inventory, e.g. when item removed from sale edit).
async function incrementProductQuantities(items) {
    for (const item of items) {
        const qty = Math.max(0, Number(item.quantity) || 0);
        if (qty === 0) continue;
        await Product.findOneAndUpdate(
            { sku: item.sku },
            { $inc: { quantity: qty } }
        );
    }
}

/**
 * Reverse inventory and ledger for a sale (used by void and hard delete).
 * Caller must pass a lean sale doc with items, _id, reference, type, customerId, total, payments, tenantId.
 * Optionally pass voidedByUserId for payment ledger reversal audit.
 */
async function reverseSaleInventoryAndLedger(sale, voidedByUserId = null) {
    const items = sale.items || [];
    const refLabel = (sale.reference || '').trim() || `Sale ${sale._id}`;

    const allSerials = items.flatMap((i) => (i.serialNumbers || []).filter(Boolean).map((s) => String(s).trim()));
    const tenantIdForIndex = sale.tenantId || 'default';
    if (allSerials.length > 0) {
        await SoldSerial.deleteMany({ saleId: sale._id, serialNumber: { $in: allSerials } });
        const historyDocs = allSerials.map((serialNumber) => ({
            serialNumber,
            eventType: 'sale_deleted',
            referenceType: 'Sale',
            referenceId: sale._id,
            referenceLabel: refLabel,
        }));
        await SerialHistory.insertMany(historyDocs);
        // Sale create sets SerialIndex + Redis to "sold"; without this, voided IMEIs stay "sold" in lookup/search.
        await refreshSerialIndexForSerials(tenantIdForIndex, allSerials);
    }

    const toReturn = items.map((i) => ({ sku: i.sku, quantity: Math.max(0, Number(i.quantity) || 0) }));
    if (toReturn.length > 0) {
        await incrementProductQuantities(toReturn);
        await incrementPurchaseItemQuantities(toReturn.filter((i) => i.sku && String(i.sku).endsWith('-no-imei')));
    }

    if (sale.type === 'wholesale' && sale.customerId) {
        const orderTotal = round2(Number(sale.total) || 0);
        const discount = round2(Number(sale.discount) || 0);
        const netDue = round2(orderTotal - discount);
        const paidNow = round2(
            (Number(sale.payments?.cash) || 0) + (Number(sale.payments?.card) || 0) + (Number(sale.payments?.bank) || 0)
        );
        const balanceChange = round2(paidNow - netDue);
        await LedgerEntry.deleteMany({ referenceId: sale._id });
        await Customer.findByIdAndUpdate(sale.customerId, { $inc: { balance: balanceChange } });
    }

    // Payment ledger: append-only reversals (OUT for each original IN) — only if not already voided
    if (sale.status !== 'voided') {
        const saleEntries = await PaymentLedgerEntry.find({ entityType: 'Sale', entityId: sale._id }).lean();
        const tenantId = sale.tenantId || 'default';
        const now = new Date();
        for (const e of saleEntries) {
            if (e.direction !== 'in') continue;
            await PaymentLedgerEntry.create({
            tenantId,
            occurredAtUtc: now,
            accountId: e.accountId,
            method: e.method,
            direction: 'out',
            amount: e.amount,
            entityType: 'SaleVoid',
            entityId: sale._id,
            locationId: e.locationId || undefined,
            createdByUserId: voidedByUserId || undefined
            });
        }
    }
}

// Increment purchase item quantity for non-serial items (return to inventory).
async function incrementPurchaseItemQuantities(items) {
    const suffix = '-no-imei';
    for (const item of items) {
        const qty = Math.max(0, Number(item.quantity) || 0);
        if (qty === 0 || !item.sku || typeof item.sku !== 'string') continue;
        if (!item.sku.endsWith(suffix)) continue;
        const prefix = item.sku.slice(0, -suffix.length);
        const firstDash = prefix.indexOf('-');
        if (firstDash <= 0) continue;
        const purchaseId = prefix.slice(0, firstDash);
        const itemId = prefix.slice(firstDash + 1);
        const purchase = await Purchase.findById(purchaseId);
        if (!purchase || !purchase.items || !Array.isArray(purchase.items)) continue;
        const subdoc = purchase.items.find((i) => String(i._id) === String(itemId));
        if (!subdoc || !subdoc.isOtherItem) continue;
        const current = Number(subdoc.quantity) || 0;
        subdoc.quantity = current + qty;
        await purchase.save();
    }
}

// @desc    Get sold serials with customer info (for showing "Sold to [Customer Name]" in inventory).
//          Optional ?serials=imei1,imei2 limits response to those serials (faster when only need a subset).
// @route   GET /api/sales/sold-serials
// @access  Private
exports.getSoldSerials = asyncHandler(async (req, res) => {
    const serialsParam = (req.query.serials || '').trim();
    const tenantId = getTenantIdFromReq(req);
    const params = { serials: serialsParam || null };
    const data = await cache.cached(
        { ns: 'sales:soldSerials', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => {
            const query = { status: { $ne: 'returned' } };
            if (serialsParam) {
                const serials = serialsParam.split(',').map((s) => s.trim()).filter(Boolean);
                if (serials.length > 0) query.serialNumber = { $in: serials };
            }
            const sold = await SoldSerial.find(query)
                .select('serialNumber saleId soldAt')
                .populate('saleId', 'customerName reference createdAt status')
                .lean();
            return sold
                .filter((s) => s.saleId && s.saleId.status !== 'voided')
                .map((s) => ({
                    serialNumber: (s.serialNumber && String(s.serialNumber).trim()) || '',
                    customerName: (s.saleId && s.saleId.customerName) ? String(s.saleId.customerName) : 'Walk-in',
                    saleReference: (s.saleId && s.saleId.reference) ? String(s.saleId.reference) : '',
                    saleId: (s.saleId && s.saleId._id) ? String(s.saleId._id) : '',
                    soldAt: s.soldAt
                }));
        }
    );
    res.status(200).json({ success: true, data });
});

// @desc    Get all sales
// @route   GET /api/sales
// @access  Private
exports.getSales = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);
    const mongoose = require('mongoose');

    const userScopeForCache = getUserLocationScope(req.user);
    const cacheParams = {
        page, limit,
        userScope: Array.isArray(userScopeForCache) ? [...userScopeForCache].sort() : null,
        locationId: req.query.locationId || null,
        type: req.query.type || null,
        paymentMethod: req.query.paymentMethod || null,
        from: req.query.from || null,
        to: req.query.to || null,
        minTotal: req.query.minTotal != null ? String(req.query.minTotal) : null,
        maxTotal: req.query.maxTotal != null ? String(req.query.maxTotal) : null,
        hasReturn: req.query.hasReturn || null,
        search: req.query.search || null,
        order: req.query.order || null,
        includeItems: req.query.includeItems === 'true' ? '1' : null,
    };

    const payload = await cache.cached(
        { ns: 'sales:list', tenantId, params: cacheParams, ttlSec: TTL.TRANSACTIONAL },
        async () => {

    const query = { status: { $ne: 'voided' }, tenantId };
    const andParts = [];

    // Phase 3: Location-based access control
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        query.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    const locParam = req.query.locationId && String(req.query.locationId).trim();
    if (locParam && mongoose.Types.ObjectId.isValid(locParam)) {
        const locStr = String(new mongoose.Types.ObjectId(locParam));
        if (!userScope || userScope.length === 0) {
            query.locationId = new mongoose.Types.ObjectId(locParam);
        } else if (userScope.includes(locStr)) {
            query.locationId = new mongoose.Types.ObjectId(locParam);
        }
    }

    if (req.query.type) query.type = req.query.type;

    if (req.query.paymentMethod && ['cash', 'card', 'credit', 'bank'].includes(String(req.query.paymentMethod))) {
        query.paymentMethod = String(req.query.paymentMethod);
    }

    const fromQ = req.query.from && String(req.query.from).trim();
    const toQ = req.query.to && String(req.query.to).trim();
    if (fromQ || toQ) {
        query.createdAt = {};
        if (fromQ) {
            const d = new Date(fromQ);
            if (!Number.isNaN(d.getTime())) query.createdAt.$gte = d;
        }
        if (toQ) {
            const end = new Date(toQ);
            if (!Number.isNaN(end.getTime())) {
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }
        if (Object.keys(query.createdAt).length === 0) delete query.createdAt;
    }

    const minTotal = req.query.minTotal != null && String(req.query.minTotal).trim() !== '' ? Number(req.query.minTotal) : null;
    const maxTotal = req.query.maxTotal != null && String(req.query.maxTotal).trim() !== '' ? Number(req.query.maxTotal) : null;
    if (minTotal != null && !Number.isNaN(minTotal)) {
        query.total = { ...(query.total || {}), $gte: minTotal };
    }
    if (maxTotal != null && !Number.isNaN(maxTotal)) {
        query.total = { ...(query.total || {}), $lte: maxTotal };
    }

    const hasReturnFilter = req.query.hasReturn === 'yes' || req.query.hasReturn === 'no' ? String(req.query.hasReturn) : null;
    let refsWithReturn = null;
    if (hasReturnFilter) {
        refsWithReturn = await SalesReturn.distinct('linkedInvoiceRef', { tenantId });
        refsWithReturn = (refsWithReturn || []).filter(Boolean);
        if (hasReturnFilter === 'yes') {
            if (refsWithReturn.length === 0) {
                andParts.push({ _id: { $in: [] } });
            } else {
                andParts.push({ reference: { $in: refsWithReturn } });
            }
        } else if (refsWithReturn.length > 0) {
            andParts.push({ reference: { $nin: refsWithReturn } });
        }
    }

    const searchStr = (req.query.search && String(req.query.search).trim()) || '';
    if (searchStr) {
        const safe = escapeRegex(searchStr);
        const looksLikeSerial = /^\d{8,}$/.test(searchStr) || (searchStr.length >= 8 && /^[A-Za-z0-9]+$/.test(searchStr));
        let activeSaleId = null;
        if (looksLikeSerial) {
            const sold = await SoldSerial.findOne({ serialNumber: searchStr, status: { $ne: 'returned' } }).select('saleId').lean();
            if (sold && sold.saleId) {
                const active = await Sale.findOne({ _id: sold.saleId, tenantId, status: { $ne: 'voided' } }).select('_id').lean();
                if (active) activeSaleId = active._id;
            }
        }
        if (activeSaleId) {
            query._id = activeSaleId;
        } else {
            const rx = new RegExp(safe, 'i');
            const orClause = [
                { reference: rx },
                { customerName: rx },
                { 'items.sku': rx },
                { 'items.name': rx },
                { 'items.serialNumbers': rx }
            ];
            const custIds = await Customer.find({
                tenantId,
                $or: [{ name: rx }, { contactName: rx }, { email: rx }, { phone: rx }, { mobile: rx }]
            })
                .select('_id')
                .lean();
            const ids = (custIds || []).map((c) => c._id).filter(Boolean);
            if (ids.length > 0) {
                orClause.push({ customerId: { $in: ids } });
            }
            andParts.push({ $or: orClause });
        }
    }

    if (andParts.length > 0) {
        query.$and = andParts;
    }

    const sortOrder = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    // For list view: exclude heavy items array when not searching (items only needed for search matching, not display)
    const salesQuery = Sale.find(query)
        .populate('customerId', 'name phone email address')
        .populate('locationId', 'name')
        .sort({ createdAt: sortOrder })
        .skip(startIndex)
        .limit(limit);
    const includeItems = req.query.includeItems === 'true';
    if (!searchStr && !includeItems) {
        salesQuery.select('-items');
    }
    salesQuery.lean();

    // Run count + find in parallel
    const [total, sales] = await Promise.all([
        Sale.countDocuments(query),
        salesQuery
    ]);

    // Fetch return status in parallel for the page's sales (not sequentially after)
    const refs = (sales || []).map((s) => s.reference).filter(Boolean);
    const returnedRefs = new Set();
    if (refs.length > 0) {
        const returns = await SalesReturn.find({ linkedInvoiceRef: { $in: refs }, tenantId }).select('linkedInvoiceRef').lean();
        returns.forEach((r) => {
            if (r.linkedInvoiceRef) returnedRefs.add(r.linkedInvoiceRef);
        });
    }
    const data = (sales || []).map((s) => ({
        ...s,
        hasReturn: returnedRefs.has(s.reference)
    }));

            return { total, data };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.data.length,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit) || 1,
        data: payload.data
    });
});

// @desc    Get single sale by ID
// @route   GET /api/sales/:id
// @access  Private
exports.getSaleById = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const sale = await Sale.findOne({ _id: req.params.id, tenantId })
        .populate('customerId', 'name phone email address')
        .populate('locationId', 'name address city country phone email')
        .lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    // Phase 3: Location-based access control - verify user can access this sale's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && sale.locationId) {
        const saleLocationId = sale.locationId._id ? sale.locationId._id.toString() : String(sale.locationId);
        if (!userScope.includes(saleLocationId)) {
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }
    }
    const ref = (sale.reference || '').trim();
    const hasReturn = ref
        ? (await SalesReturn.countDocuments({ linkedInvoiceRef: ref, tenantId })) > 0
        : false;

    // Resolve per-IMEI SID for each sale item via its source Purchase. Falls back to
    // the legacy item-level `serialItemIdNumber` when per-IMEI mapping is absent.
    const items = Array.isArray(sale.items) ? sale.items : [];
    const purchaseIds = [...new Set(
        items.map((i) => i.purchaseId).filter(Boolean).map(String)
    )];
    if (purchaseIds.length > 0) {
        const purchases = await Purchase.find({ _id: { $in: purchaseIds }, tenantId })
            .select('items._id items.imeis items.imeiSerials items.serialItemIdNumber')
            .lean();
        const itemById = new Map();
        for (const p of purchases) {
            for (const pi of p.items || []) {
                itemById.set(String(pi._id), pi);
            }
        }
        for (const it of items) {
            const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [];
            if (!it.purchaseItemId || serials.length === 0) {
                it.serialIds = {};
                continue;
            }
            const pi = itemById.get(String(it.purchaseItemId));
            const map = {};
            const perImei = new Map();
            for (const e of (pi && pi.imeiSerials) || []) {
                if (e && e.imei) perImei.set(String(e.imei).trim(), e.serialItemIdNumber || '');
            }
            const fallback = (pi && pi.serialItemIdNumber) || '';
            for (const s of serials) {
                const key = String(s).trim();
                map[key] = perImei.get(key) || fallback || '';
            }
            it.serialIds = map;
        }
    }

    res.status(200).json({ success: true, data: { ...sale, items, hasReturn } });
});

// @desc    Update sale (items, totals)
// @route   PUT /api/sales/:id
// @access  Private
exports.updateSale = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const sale = await Sale.findOne({ _id: req.params.id, tenantId });
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this sale's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && sale.locationId) {
        const saleLocationId = sale.locationId.toString ? sale.locationId.toString() : String(sale.locationId);
        if (!userScope.includes(saleLocationId)) {
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }
    }

    if (sale.status === 'voided') {
        return res.status(400).json({ success: false, message: 'Cannot edit a voided invoice' });
    }
    
    const beforeSnapshot = sale.toObject();

    const body = req.body;
    const oldCustomerIdAtStart = sale.customerId ? String(sale.customerId) : null;
    let wholesaleCustomerTransferred = false;
    let transferFromCustomerId = null;
    let transferToCustomerId = null;

    // Capture old items for inventory reconciliation (before overwriting)
    const oldItems = (sale.items || []).map((i) => ({
        sku: i.sku,
        name: i.name,
        price: i.price,
        quantity: Math.max(0, Number(i.quantity) || 0),
        serialNumbers: Array.isArray(i.serialNumbers) ? i.serialNumbers.filter(Boolean).map((s) => String(s).trim()) : []
    }));

    // Capture previous total so we can adjust customer balance / ledger for wholesale edits
    const prevTotal = round2(Number(sale.total) || 0);
    const prevDiscount = round2(Number(sale.discount) || 0);
    let newItems = [];
    if (body.items && Array.isArray(body.items)) {
        if (body.items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one item is required'
            });
        }
        for (const item of body.items) {
            if (!item.sku || item.name == null || typeof item.price !== 'number' || typeof item.quantity !== 'number') {
                return res.status(400).json({
                    success: false,
                    message: 'Each item must have sku, name, price, and quantity'
                });
            }
        }
        newItems = body.items.map((i) => ({
            sku: i.sku,
            name: i.name,
            price: i.price,
            quantity: Math.max(0, Number(i.quantity) || 0),
            unit: i.unit || 'piece',
            serialNumbers: Array.isArray(i.serialNumbers) ? i.serialNumbers.filter(Boolean).map((s) => String(s).trim()) : [],
            grade: (i.grade != null && String(i.grade).trim()) ? String(i.grade).trim() : '',
            brand: (i.brand != null && String(i.brand).trim()) ? String(i.brand).trim() : '',
            colour: (i.colour != null && String(i.colour).trim()) ? String(i.colour).trim() : '',
            brandModel: (i.brandModel != null && String(i.brandModel).trim()) ? String(i.brandModel).trim() : '',
            capacity: (i.capacity != null && String(i.capacity).trim()) ? String(i.capacity).trim() : '',
            unit_cost_at_sale: typeof i.unit_cost_at_sale === 'number' ? round2(i.unit_cost_at_sale) : undefined
        }));
        const existingItems = sale.items || [];
        const canOverrideCost = req.user && (req.user.role === 'admin' || (req.user.permissionKeys && req.user.permissionKeys.has('user.manage')));
        const resolved = await salesTransactionService.resolveCostsForSaleItems(newItems, sale.type || 'retail', null, getTenantIdFromReq(req));
        sale.items = newItems.map((i, idx) => {
            const existing = existingItems[idx];
            const fromResolve = resolved[idx];
            let unit_cost_at_sale = 0;
            let cost_missing = false;
            let purchaseId = null;
            let purchaseItemId = null;
            if (typeof i.unit_cost_at_sale === 'number' && canOverrideCost) {
                unit_cost_at_sale = round2(i.unit_cost_at_sale);
                cost_missing = false;
            } else if (existing && (Number(existing.unit_cost_at_sale) || 0) > 0) {
                unit_cost_at_sale = round2(Number(existing.unit_cost_at_sale));
                cost_missing = !!existing.cost_missing;
                purchaseId = existing.purchaseId || null;
                purchaseItemId = existing.purchaseItemId || null;
            } else if (fromResolve) {
                unit_cost_at_sale = round2(Number(fromResolve.unit_cost_at_sale) || 0);
                cost_missing = !!fromResolve.cost_missing;
                purchaseId = fromResolve.purchaseId || null;
                purchaseItemId = fromResolve.purchaseItemId || null;
            }
            return {
                sku: i.sku,
                name: i.name,
                price: i.price,
                quantity: i.quantity,
                unit: i.unit || 'piece',
                serialNumbers: [...(i.serialNumbers || [])],
                grade: i.grade || '',
                brand: i.brand || '',
                colour: i.colour || '',
                brandModel: i.brandModel || '',
                capacity: i.capacity || '',
                unit_cost_at_sale,
                cost_missing,
                purchaseId,
                purchaseItemId
            };
        });
    }

    if (typeof body.subtotal === 'number') sale.subtotal = body.subtotal;
    if (typeof body.tax === 'number') sale.tax = body.tax;
    if (typeof body.total === 'number') sale.total = body.total;
    if (typeof body.discount === 'number') sale.discount = body.discount;
    if (body.discountType === 'flat' || body.discountType === 'percent') sale.discountType = body.discountType;
    if (typeof body.discountValue === 'number') sale.discountValue = body.discountValue;
    if (typeof body.note === 'string') sale.note = body.note.trim();
    // For edits we intentionally do NOT change amountDue or payments unless explicitly provided.
    let prevPaymentTotal = 0;
    if (sale.type === 'wholesale' && sale.payments) {
        prevPaymentTotal = round2((Number(sale.payments.cash) || 0) + (Number(sale.payments.card) || 0) + (Number(sale.payments.bank) || 0));
    }
    if (sale.type === 'wholesale' && body.payments) {
        const { getEffectiveRetailModeEnabled } = require('../utils/effectiveRetailMode');
        const retailModeActive = await getEffectiveRetailModeEnabled(req.user._id);
        if (retailModeActive) {
            const credit = round2(Number(body.payments.credit) || 0);
            if (credit > 0.01) {
                return res.status(400).json({
                    success: false,
                    message: 'Retail mode does not allow credit. Full payment is required.'
                });
            }
            const paidSum = round2(
                (Number(body.payments.cash) || 0) +
                (Number(body.payments.card) || 0) +
                (Number(body.payments.bank) || 0)
            );
            const checkoutTotal = computeWholesaleTotalOwing({
                total: typeof body.total === 'number' ? body.total : sale.total,
                discount: typeof body.discount === 'number' ? body.discount : sale.discount,
                previousBalance:
                    typeof body.previousBalance === 'number' ? body.previousBalance : sale.previousBalance,
            });
            if (paidSum < checkoutTotal - 0.01) {
                const remaining = round2(checkoutTotal - paidSum);
                return res.status(400).json({
                    success: false,
                    message: `Retail mode requires full payment. Remaining: £${remaining.toFixed(2)}`
                });
            }
        }
        sale.payments = normalizePaymentBreakdown(body.payments);
        sale.amountDue = computeRemainingAmountDue({
            total: sale.total,
            discount: sale.discount,
            previousBalance: sale.previousBalance,
            payments: sale.payments,
        });
    } else if (
        sale.type === 'wholesale' &&
        (typeof body.total === 'number' ||
            typeof body.discount === 'number' ||
            typeof body.previousBalance === 'number')
    ) {
        sale.amountDue = computeRemainingAmountDue({
            total: sale.total,
            discount: sale.discount,
            previousBalance: sale.previousBalance,
            payments: sale.payments,
        });
    }

    if (sale.type === 'wholesale' && body.customerId !== undefined) {
        const newCustomerId = body.customerId ? String(body.customerId) : null;
        if (newCustomerId !== oldCustomerIdAtStart) {
            if (newCustomerId) {
                const acct = await resolveWholesaleSaleAccount(newCustomerId, tenantId);
                if (!acct) {
                    return res.status(400).json({ success: false, message: 'Customer or supplier account not found' });
                }
                sale.customerId = acct.id;
                sale.customerName = (body.customerName && String(body.customerName).trim()) || acct.name;
            } else {
                sale.customerId = null;
                sale.customerName = body.customerName ? String(body.customerName).trim() : null;
            }
            wholesaleCustomerTransferred = true;
            transferFromCustomerId = oldCustomerIdAtStart;
            transferToCustomerId = newCustomerId;
        } else if (body.customerName != null && String(body.customerName).trim()) {
            sale.customerName = String(body.customerName).trim();
        }
    } else if (sale.type === 'wholesale' && body.customerName != null && String(body.customerName).trim()) {
        sale.customerName = String(body.customerName).trim();
    }

    // Validate added serials are not already sold and not returned to supplier (before saving)
    if (newItems.length > 0) {
        const oldSerialsCheck = oldItems.flatMap((i) => i.serialNumbers || []);
        const newSerialsCheck = newItems.flatMap((i) => i.serialNumbers || []);
        const oldSetCheck = new Set(oldSerialsCheck);
        const addedSerialsCheck = [...new Set(newSerialsCheck)].filter((s) => !oldSetCheck.has(s));
        for (const serial of addedSerialsCheck) {
            const blocking = await findActiveSoldSerialsAmong([serial]);
            const other = blocking.find((b) => String(b.saleId) !== String(sale._id));
            if (other) {
                return res.status(400).json({ success: false, message: `Serial ${serial} is already sold on another invoice` });
            }
            const returnedToSupplierHistory = await SerialHistory.findOne({ serialNumber: serial, eventType: 'returned_to_supplier' }).select('_id').lean();
            if (returnedToSupplierHistory) {
                return res.status(400).json({ success: false, message: `Serial ${serial} was returned to supplier and is not available to sell` });
            }
            const soldReturnedToSupplier = await SoldSerial.findOne({ serialNumber: serial, status: 'returned', returnDestination: 'return_to_supplier' }).select('_id').lean();
            if (soldReturnedToSupplier) {
                return res.status(400).json({ success: false, message: `Serial ${serial} was returned to supplier and is not available to sell` });
            }
        }
    }

    await sale.save();

    // Inventory sync: add back removed items (serials + qty), remove added items (serials + qty)
    if (oldItems.length > 0 || newItems.length > 0) {
        const oldSerials = oldItems.flatMap((i) => i.serialNumbers || []);
        const newSerials = newItems.flatMap((i) => i.serialNumbers || []);
        const oldSerialSet = new Set(oldSerials);
        const newSerialSet = new Set(newSerials);
        const removedSerials = [...oldSerialSet].filter((s) => !newSerialSet.has(s));
        const addedSerials = [...newSerialSet].filter((s) => !oldSerialSet.has(s));

        // Return removed serials to inventory (delete SoldSerial for this sale); log history first
        const refLabel = (sale.reference || '').trim() || `Sale ${sale._id}`;
        if (removedSerials.length > 0) {
            const removedHistoryDocs = removedSerials.map((serialNumber) => ({
                serialNumber,
                eventType: 'removed_from_invoice',
                referenceType: 'Sale',
                referenceId: sale._id,
                referenceLabel: refLabel,
            }));
            await SerialHistory.insertMany(removedHistoryDocs);
            await SoldSerial.deleteMany({ saleId: sale._id, serialNumber: { $in: removedSerials } });
            await refreshSerialIndexForSerials(tenantId, removedSerials);
        }

        // Remove added serials from inventory (insert SoldSerial); validate not already sold elsewhere; log history
        const customerName = (sale.customerName != null && sale.customerName !== '') ? String(sale.customerName).trim() : '';
        for (const serial of addedSerials) {
            const blocking = await findActiveSoldSerialsAmong([serial]);
            const other = blocking.find((b) => String(b.saleId) !== String(sale._id));
            if (other) {
                return res.status(400).json({ success: false, message: `Serial ${serial} is already sold on another invoice` });
            }
            const existingOnThisSale = await SoldSerial.findOne({ serialNumber: serial, saleId: sale._id, status: { $ne: 'returned' } }).lean();
            if (!existingOnThisSale) {
                await SoldSerial.create({ serialNumber: serial, saleId: sale._id, soldAt: new Date() });
                await SerialHistory.create({
                    serialNumber: serial,
                    eventType: 'sold',
                    referenceType: 'Sale',
                    referenceId: sale._id,
                    referenceLabel: refLabel,
                    customerName,
                });
                serialIndexService.upsertSerialIndex(tenantId, {
                    serial,
                    status: 'sold',
                    saleId: sale._id,
                    saleReferenceSnapshot: refLabel,
                    customerNameSnapshot: customerName,
                }).catch(() => {});
            }
        }

        // Quantity diff by sku (Product + non-serial Purchase items)
        function aggregateBySku(items) {
            const bySku = {};
            for (const item of items) {
                const sku = item.sku && String(item.sku).trim();
                if (!sku) continue;
                bySku[sku] = (bySku[sku] || 0) + Math.max(0, Number(item.quantity) || 0);
            }
            return bySku;
        }
        const oldBySku = aggregateBySku(oldItems);
        const newBySku = aggregateBySku(newItems);
        const allSkus = new Set([...Object.keys(oldBySku), ...Object.keys(newBySku)]);
        const toReturn = [];
        const toSell = [];
        for (const sku of allSkus) {
            const oldQ = oldBySku[sku] || 0;
            const newQ = newBySku[sku] || 0;
            const delta = newQ - oldQ;
            if (delta < 0) toReturn.push({ sku, quantity: -delta });
            if (delta > 0) toSell.push({ sku, quantity: delta });
        }
        if (toReturn.length > 0) {
            await incrementProductQuantities(toReturn);
            await incrementPurchaseItemQuantities(toReturn.filter((i) => i.sku.endsWith('-no-imei')));
        }
        if (toSell.length > 0) {
            await decrementProductQuantities(toSell);
            await decrementPurchaseItemQuantities(toSell.filter((i) => i.sku.endsWith('-no-imei')));
        }
    }

    // Rigid accounting: do NOT delete or overwrite existing payment_in or sale ledger entries.
    // Record corrections as NEW entries (adjustment) so history is immutable and auditable.
    const refLabel = sale.reference || `Sale ${sale._id}`;
    const now = new Date();
    const userId = req.user?._id || req.user?.id;

    if (wholesaleCustomerTransferred) {
        if (transferFromCustomerId) {
            const oldAcct = await resolveWholesaleSaleAccount(transferFromCustomerId, tenantId);
            if (oldAcct?.hasCustomerLedger) {
                await postWholesaleCustomerLedgerForSale(sale, oldAcct.id, oldAcct.accountModel, userId, -1);
            }
        }
        if (transferToCustomerId) {
            const newAcct = await resolveWholesaleSaleAccount(transferToCustomerId, tenantId);
            if (newAcct?.hasCustomerLedger) {
                await postWholesaleCustomerLedgerForSale(sale, newAcct.id, newAcct.accountModel, userId, 1);
            }
        }
    }

    if (!wholesaleCustomerTransferred && sale.type === 'wholesale' && sale.customerId && body.payments) {
        const newPaymentTotal = round2(
            (Number(sale.payments.cash) || 0) + (Number(sale.payments.card) || 0) + (Number(sale.payments.bank) || 0)
        );
        const oldPaymentEntries = await LedgerEntry.find({
            accountType: 'customer',
            accountId: sale.customerId,
            type: 'payment_in',
            referenceId: sale._id,
            deletedAt: null
        }).lean();
        const oldPaymentSum = round2(oldPaymentEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0));
        const paymentDelta = round2(-newPaymentTotal - oldPaymentSum);
        if (paymentDelta !== 0) {
            await LedgerEntry.create({
                accountType: 'customer',
                accountId: sale.customerId,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: paymentDelta,
                referenceId: sale._id,
                referenceLabel: `Payment adjustment - ${refLabel}`,
                date: now,
                occurredAt: now,
                createdBy: userId
            });
            await Customer.findByIdAndUpdate(sale.customerId, { $inc: { balance: paymentDelta } });
        }
    }

    const newTotal = round2(Number(sale.total) || 0);
    const newDiscount = round2(Number(sale.discount) || 0);
    const deltaTotal = round2((newTotal - newDiscount) - (prevTotal - prevDiscount));
    if (!wholesaleCustomerTransferred && sale.type === 'wholesale' && sale.customerId && deltaTotal !== 0) {
        await LedgerEntry.create({
            accountType: 'customer',
            accountId: sale.customerId,
            accountModel: 'Customer',
            type: 'sale',
            amount: deltaTotal,
            referenceId: sale._id,
            referenceLabel: `Invoice adjustment - ${refLabel}`,
            date: now,
            occurredAt: now,
            createdBy: userId
        });
        await Customer.findByIdAndUpdate(sale.customerId, { $inc: { balance: deltaTotal } });
    }
    if (deltaTotal !== 0) {
        metricsService.saleTotalEditDelta(
            tenantId,
            sale.locationId || null,
            sale.occurredAt || sale.createdAt,
            deltaTotal
        ).catch(() => {});
    }

    await auditService.logFromReq(req, 'Sale', sale._id, 'UPDATE', {
        before: beforeSnapshot,
        after: sale.toObject()
    });
    await activityLogService.logFromReq(req, {
        action: 'EDIT_SALE',
        entityType: 'Sale',
        entityId: sale._id,
        saleId: sale._id,
        invoiceNo: (sale.reference || '').trim(),
        customerId: sale.customerId || null,
        success: true,
        message: `Sale updated ${sale.reference || sale._id}`,
        beforeJson: beforeSnapshot,
        afterJson: sale.toObject(),
        diffJson: { before: beforeSnapshot, after: sale.toObject() }
    });

    await invalidateSalesCaches(tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    await cache.bumpNs('customers:list', tenantId);

    res.status(200).json({
        success: true,
        message: 'Sale updated successfully',
        data: {
            _id: sale._id.toString(),
            reference: sale.reference
        }
    });
});

// @desc    Void sale (soft delete): set status=voided, reverse inventory/ledger, decrement metrics once.
// @route   DELETE /api/sales/:id
// @access  Private
exports.deleteSale = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const sale = await Sale.findOne({ _id: req.params.id, tenantId }).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this sale's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && sale.locationId) {
        const saleLocationId = sale.locationId.toString ? sale.locationId.toString() : String(sale.locationId);
        if (!userScope.includes(saleLocationId)) {
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }
    }
    if (sale.status === 'voided') {
        return res.status(400).json({ success: false, message: 'Sale is already voided' });
    }

    const voidReason = (req.body.voidReason || '').trim() || null;
    const refLabel = (sale.reference || '').trim() || `Sale ${sale._id}`;

    await reverseSaleInventoryAndLedger(sale, req.user?.id || null);

    // 4. Soft void: update sale (do not delete)
    await Sale.findByIdAndUpdate(sale._id, {
        status: 'voided',
        voidedAtUtc: new Date(),
        voidedByUserId: req.user?.id || null,
        voidReason,
    });

    // 5. Decrement metrics only once (idempotent: we only reach here when status was active)
    metricsService.decrementSaleVoided(
        tenantId,
        sale.locationId || null,
        sale.total,
        sale.occurredAt || sale.createdAt
    ).catch(() => {});

    await auditService.logFromReq(req, 'Sale', sale._id, 'UPDATE', { before: sale, after: { status: 'voided', voidReason } });
    await activityLogService.logFromReq(req, {
        action: 'VOID_SALE',
        entityType: 'Sale',
        entityId: sale._id,
        saleId: sale._id,
        invoiceNo: refLabel,
        customerId: sale.customerId || null,
        success: true,
        message: `Sale voided ${refLabel}`,
        beforeJson: sale
    });

    // Sync StockItem: revert serial rows to in_stock; bump non-serial qty back.
    const soldSerialsForRevert = (sale.items || []).flatMap((it) => (Array.isArray(it.serialNumbers) ? it.serialNumbers : []).map((s) => String(s || '').trim()).filter(Boolean));
    if (soldSerialsForRevert.length > 0) {
        stockItemService.markInStock(soldSerialsForRevert, tenantId).catch(() => {});
    }
    for (const item of (sale.items || [])) {
        const serials = Array.isArray(item.serialNumbers) ? item.serialNumbers : [];
        if (serials.length > 0) continue;
        const qty = Number(item.quantity) || 0;
        if (qty > 0 && item.purchaseId && item.purchaseItemId) {
            stockItemService.incrementNonSerialQty(tenantId, item.purchaseId, item.purchaseItemId, qty).catch(() => {});
        }
    }
    require('./purchaseController').invalidateTypeaheadCache?.(tenantId);

    await invalidateSalesCaches(tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    await cache.bumpNs('customers:list', tenantId);

    res.status(200).json({
        success: true,
        message: 'Sale voided; items returned to inventory',
        data: { _id: sale._id.toString(), reference: refLabel }
    });
});

// @desc    Hard delete sale (admin only). Requires confirmation. Reverses inventory/ledger, decrements metrics if active, then permanently deletes.
// @route   DELETE /api/sales/:id/hard
// @access  Private (sale.delete + admin role)
exports.hardDeleteSale = asyncHandler(async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only admin can hard delete a sale' });
    }
    const tenantId = getTenantIdFromReq(req);
    const sale = await Sale.findOne({ _id: req.params.id, tenantId }).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    
    // Phase 3: Location-based access control - admin can access all locations, but verify for consistency
    // (Admin bypasses location check, but we keep the check for consistency)
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && sale.locationId) {
        const saleLocationId = sale.locationId.toString ? sale.locationId.toString() : String(sale.locationId);
        if (!userScope.includes(saleLocationId)) {
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }
    }

    const refLabel = (sale.reference || '').trim() || `Sale ${sale._id}`;
    const confirmHeader = (req.headers['x-confirm-delete'] || '').trim();
    const confirmBody = (req.body?.confirmInvoiceRef || '').trim();
    const confirmed = confirmHeader === refLabel || confirmBody === refLabel;
    if (!confirmed) {
        return res.status(400).json({
            success: false,
            message: 'Confirmation required: set header X-Confirm-Delete or body confirmInvoiceRef to the invoice reference (e.g. INV-000001)',
        });
    }

    await reverseSaleInventoryAndLedger(sale);

    if (sale.status === 'active') {
        metricsService.decrementSaleVoided(
            tenantId,
            sale.locationId || null,
            sale.total,
            sale.occurredAt || sale.createdAt
        ).catch(() => {});
    }

    await activityLogService.logFromReq(req, {
        action: 'SALE_HARD_DELETED',
        entityType: 'Sale',
        entityId: sale._id,
        saleId: sale._id,
        invoiceNo: refLabel,
        customerId: sale.customerId || null,
        success: true,
        message: `Sale permanently deleted ${refLabel}`,
        beforeJson: sale,
        metaJson: { hardDeletedBy: req.user?.id?.toString(), hardDeletedAt: new Date().toISOString() },
    });

    await Sale.findByIdAndDelete(sale._id);

    await invalidateSalesCaches(tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    await cache.bumpNs('customers:list', tenantId);

    res.status(200).json({
        success: true,
        message: 'Sale permanently deleted',
        data: { _id: sale._id.toString(), reference: refLabel },
    });
});

/** Normalize a user-entered invoice reference: trim, uppercase, collapse internal whitespace. */
function normalizeReference(raw) {
    if (raw == null) return '';
    return String(raw).trim().toUpperCase().replace(/\s+/g, '');
}

/** Allow letters, digits, dash, slash, underscore; 1..32 chars. */
const REFERENCE_REGEX = /^[A-Z0-9\-\/_]{1,32}$/;

// @desc    Check if an invoice reference is already used (tenant-scoped)
// @route   GET /api/sales/check-reference?reference=XXX
// @access  Private
exports.checkReference = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const normalized = normalizeReference(req.query.reference);
    if (!normalized) {
        return res.status(200).json({ success: true, data: { reference: '', exists: false, valid: false, reason: 'empty' } });
    }
    if (!REFERENCE_REGEX.test(normalized)) {
        return res.status(200).json({ success: true, data: { reference: normalized, exists: false, valid: false, reason: 'invalid_format' } });
    }
    const existing = await Sale.findOne({ tenantId, reference: normalized }).select('_id').lean();
    return res.status(200).json({
        success: true,
        data: { reference: normalized, exists: !!existing, valid: true }
    });
});

// @desc    Create sale (retail or wholesale)
// @route   POST /api/sales
// @access  Private
exports.createSale = asyncHandler(async (req, res) => {
    const body = req.body;
    const tenantId = getTenantIdFromReq(req);
    if (body.tenantId !== undefined) delete body.tenantId;

    if (!body.type || !['retail', 'wholesale'].includes(body.type)) {
        return res.status(400).json({
            success: false,
            message: 'type must be "retail" or "wholesale"'
        });
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'At least one item is required'
        });
    }

    for (const item of body.items) {
        if (!item.sku || item.name == null || typeof item.price !== 'number' || typeof item.quantity !== 'number') {
            return res.status(400).json({
                success: false,
                message: 'Each item must have sku, name, price, and quantity'
            });
        }
    }

    // Phase 3: Location-based access control - validate locationId if provided
    let locationId = body.locationId || null;
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        // Non-admin: must use assigned location or defaultLocationId (if in scope)
        if (locationId) {
            const locationIdStr = locationId.toString ? locationId.toString() : String(locationId);
            if (!userScope.includes(locationIdStr)) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to create sales for this location'
                });
            }
        } else {
            // Use defaultLocationId if in scope, otherwise use first assigned location
            const defaultLocId = req.user?.defaultLocationId?.toString();
            if (defaultLocId && userScope.includes(defaultLocId)) {
                locationId = defaultLocId;
            } else if (userScope.length > 0) {
                locationId = userScope[0];
            }
        }
    } else if (!locationId && req.user?.defaultLocationId) {
        // Admin or empty assignedLocationIds: use defaultLocationId if available
        locationId = req.user.defaultLocationId;
    }

    // [DEBUG] Inspect incoming items — particularly per-serial colour mapping
    console.log('[createSale] incoming items:', JSON.stringify(body.items, null, 2));

    // Idempotency: if the client supplied a request id and a sale with that id already
    // exists for this tenant, return it instead of trying to create a duplicate. This is
    // what protects against the "Serial number(s) already sold" error when a network
    // retry resends the same checkout.
    const clientRequestId = (typeof body.clientRequestId === 'string' && body.clientRequestId.trim())
        ? body.clientRequestId.trim().slice(0, 64)
        : null;
    if (clientRequestId) {
        const existing = await Sale.findOne({ tenantId, clientRequestId }).select('_id reference').lean();
        if (existing) {
            return res.status(200).json({
                success: true,
                message: 'Sale already recorded (idempotent replay)',
                data: { _id: existing._id.toString(), reference: existing.reference },
                idempotent: true
            });
        }
    }

    // Optional user-supplied invoice reference (custom invoice number). Empty → auto-generate.
    let customReference = '';
    if (body.reference != null && String(body.reference).trim() !== '') {
        customReference = normalizeReference(body.reference);
        if (!REFERENCE_REGEX.test(customReference)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid invoice number format. Use up to 32 chars: letters, digits, "-", "/", "_".'
            });
        }
        const dup = await Sale.findOne({ tenantId, reference: customReference }).select('_id').lean();
        if (dup) {
            return res.status(409).json({
                success: false,
                message: `Invoice number "${customReference}" is already in use.`,
                code: 'REFERENCE_TAKEN'
            });
        }
    }

    const saleData = {
        tenantId,
        type: body.type,
        locationId: locationId,
        reference: customReference || undefined,
        clientRequestId: clientRequestId || undefined,
        items: body.items.map((i) => {
            // Normalize serialColours (per-serial colour map): { [serial]: "BLUE" }
            // Frontend may send as plain object; coerce keys to trimmed strings.
            let serialColours;
            if (i.serialColours && typeof i.serialColours === 'object' && !Array.isArray(i.serialColours)) {
                serialColours = {};
                for (const [k, v] of Object.entries(i.serialColours)) {
                    const key = String(k || '').trim();
                    const val = (v != null && String(v).trim()) ? String(v).trim() : '';
                    if (key && val) serialColours[key] = val;
                }
                if (Object.keys(serialColours).length === 0) serialColours = undefined;
            }
            console.log('[createSale] item map →', { sku: i.sku, serialNumbers: i.serialNumbers, colour: i.colour, serialColours });
            return {
                sku: i.sku,
                name: i.name,
                price: i.price,
                quantity: i.quantity,
                unit: i.unit || 'piece',
                serialNumbers: Array.isArray(i.serialNumbers) ? i.serialNumbers : [],
                serialColours,
                grade: (i.grade != null && String(i.grade).trim()) ? String(i.grade).trim() : '',
                brand: (i.brand != null && String(i.brand).trim()) ? String(i.brand).trim() : '',
                colour: (i.colour != null && String(i.colour).trim()) ? String(i.colour).trim() : '',
                brandModel: (i.brandModel != null && String(i.brandModel).trim()) ? String(i.brandModel).trim() : '',
                capacity: (i.capacity != null && String(i.capacity).trim()) ? String(i.capacity).trim() : '',
                unit_cost_at_sale: i.unit_cost_at_sale != null ? Number(i.unit_cost_at_sale) : undefined,
                purchaseId: i.purchaseId || undefined,
                purchaseItemId: i.purchaseItemId || undefined,
                cost_missing: !!i.cost_missing
            };
        }),
        subtotal: Number(body.subtotal) || 0,
        tax: Number(body.tax) || 0,
        total: Number(body.total) || 0,
        discount: Number(body.discount) || 0,
        discountType: body.discountType === 'percent' ? 'percent' : 'flat',
        discountValue: Number(body.discountValue) || 0,
        note: typeof body.note === 'string' ? body.note.trim() : '',
        soldBy: req.user?.id
    };

    if (body.type === 'retail') {
        saleData.paymentMethod = body.paymentMethod || 'cash';
    } else {
        saleData.previousBalance = Number(body.previousBalance) || 0;
        saleData.customerId = body.customerId || null;
        saleData.customerName = body.customerName || null;
        saleData.payments = normalizePaymentBreakdown(body.payments);
        saleData.amountDue = computeRemainingAmountDue({
            total: saleData.total,
            discount: saleData.discount,
            previousBalance: saleData.previousBalance,
            payments: saleData.payments,
        });
        saleData.bankAccount = body.bankAccount || undefined;
    }

    // Retail mode (walk-in): enforce full payment, no credit, use Walk-in customer if none
    const generalSettings = await GeneralSettings.getSettings();
    const { getEffectiveRetailModeEnabled } = require('../utils/effectiveRetailMode');
    const retailModeActive = await getEffectiveRetailModeEnabled(req.user._id);
    if (body.type === 'wholesale' && retailModeActive) {
        const creditAmount = round2(Number(saleData.payments?.credit) || 0);
        if (creditAmount > 0.01) {
            return res.status(400).json({
                success: false,
                message: 'Retail mode does not allow credit. Full payment is required.'
            });
        }
        const paidSum = round2(
            (Number(saleData.payments?.cash) || 0) +
            (Number(saleData.payments?.card) || 0) +
            (Number(saleData.payments?.bank) || 0)
        );
        const checkoutTotal = computeWholesaleTotalOwing({
            total: saleData.total,
            discount: saleData.discount,
            previousBalance: saleData.previousBalance,
        });
        if (paidSum < checkoutTotal - 0.01) {
            const remaining = round2(checkoutTotal - paidSum);
            return res.status(400).json({
                success: false,
                message: `Retail mode requires full payment. Remaining: £${remaining.toFixed(2)}`
            });
        }
        if (!saleData.customerId) {
            const walkIn = await Customer.findOne({ isWalkIn: true, tenantId }).select('_id name').lean();
            if (!walkIn) {
                const byName = await Customer.findOne({ name: 'Walk-in Customer', tenantId }).select('_id name').lean();
                if (byName) {
                    await Customer.updateOne({ _id: byName._id }, { $set: { isWalkIn: true } });
                    saleData.customerId = byName._id;
                    saleData.customerName = byName.name;
                } else {
                    const created = await Customer.create({
                        name: 'Walk-in Customer',
                        phone: 'N/A',
                        email: '',
                        isWalkIn: true,
                        isActive: true,
                        useInRepairs: false,
                        tenantId
                    });
                    saleData.customerId = created._id;
                    saleData.customerName = created.name;
                }
            } else {
                saleData.customerId = walkIn._id;
                saleData.customerName = walkIn.name;
            }
        }
    }

    const auditCtx = activityLogService.contextFromReq(req);
    const requestStart = Date.now();
    let result;
    try {
        result = await transactionService.runWithTransaction(async (session) => {
            const saleResult = await salesTransactionService.createSaleInTransaction(session, saleData, {
                userId: req.user?.id,
                allowNegativeStock: !!generalSettings.allowNegativeStock
            });
            const auditStart = Date.now();
            await activityLogService.log({
                actorUserId: auditCtx.actorUserId,
                actorName: auditCtx.actorName,
                actorRole: auditCtx.actorRole,
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: saleResult.sale._id,
                saleId: saleResult.sale._id,
                invoiceNo: (saleResult.sale.reference || '').trim(),
                customerId: saleData.customerId || null,
                success: true,
                message: `Sale created ${saleResult.sale.reference || saleResult.sale._id}`,
                source: auditCtx.source,
                ipAddress: auditCtx.ipAddress,
                userAgent: auditCtx.userAgent,
                afterJson: { _id: saleResult.sale._id, reference: saleResult.sale.reference, total: saleResult.sale.total, itemCount: (saleResult.sale.items || []).length },
                session
            });
            const auditMs = Date.now() - auditStart;
            return { ...saleResult, auditMs };
        });
    } catch (err) {
        const msg = err.message || 'Sale creation failed';
        // Idempotency race: same clientRequestId arrived twice in parallel; the loser hits
        // the unique index. Return the winning sale instead of bubbling the error up.
        if (clientRequestId && err && err.code === 11000 && err.keyPattern && err.keyPattern.clientRequestId) {
            const existing = await Sale.findOne({ tenantId, clientRequestId }).select('_id reference').lean();
            if (existing) {
                return res.status(200).json({
                    success: true,
                    message: 'Sale already recorded (idempotent replay)',
                    data: { _id: existing._id.toString(), reference: existing.reference },
                    idempotent: true
                });
            }
        }
        // Same idea for "already sold": if the client retried with the same idempotency key,
        // surface the original sale instead of a confusing duplicate-serial error.
        if (clientRequestId && msg.includes('already sold')) {
            const existing = await Sale.findOne({ tenantId, clientRequestId }).select('_id reference').lean();
            if (existing) {
                return res.status(200).json({
                    success: true,
                    message: 'Sale already recorded (idempotent replay)',
                    data: { _id: existing._id.toString(), reference: existing.reference },
                    idempotent: true
                });
            }
        }
        if (msg.includes('already sold')) {
            return res.status(400).json({ success: false, message: msg });
        }
        if (msg.startsWith('Insufficient stock')) {
            return res.status(400).json({ success: false, message: msg });
        }
        if (err && err.code === 'REFERENCE_TAKEN') {
            return res.status(409).json({ success: false, message: err.message, code: 'REFERENCE_TAKEN' });
        }
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.reference) {
            return res.status(409).json({
                success: false,
                message: 'Invoice number is already in use.',
                code: 'REFERENCE_TAKEN'
            });
        }
        if (err.message && err.message.includes('Transaction')) {
            return res.status(503).json({
                success: false,
                message: 'Database transactions are not available. Ensure MongoDB is running as a replica set.'
            });
        }
        throw err;
    }

    const { sale, refLabel, timing = {}, auditMs = 0 } = result;
    metricsService.incrementSaleCreated(
      tenantId,
      sale.locationId || null,
      sale.total,
      sale.occurredAt || sale.createdAt
    ).catch(() => {});

    const totalRequestMs = Date.now() - requestStart;
    if (process.env.NODE_ENV !== 'test') {
        console.info('[Create Sale]', {
            totalMs: totalRequestMs,
            validationMs: timing.validationMs,
            costResolutionMs: timing.costResolutionMs,
            saleWriteMs: timing.saleWriteMs,
            ledgerMs: timing.ledgerMs,
            soldSerialMs: timing.soldSerialMs,
            decrementMs: timing.decrementMs,
            auditMs,
            itemCount: (saleData.items || []).length,
            serialCount: (saleData.items || []).reduce((s, i) => s + (Array.isArray(i.serialNumbers) ? i.serialNumbers.length : 0), 0)
        });
    }
    if (process.env.NODE_ENV === 'development' && res.setHeader) {
        const timingHeader = [
            `total;dur=${totalRequestMs}`,
            timing.validationMs != null ? `validation;dur=${timing.validationMs}` : null,
            timing.costResolutionMs != null ? `cost;dur=${timing.costResolutionMs}` : null,
            timing.saleWriteMs != null ? `saleWrite;dur=${timing.saleWriteMs}` : null,
            timing.decrementMs != null ? `decrement;dur=${timing.decrementMs}` : null,
            `audit;dur=${auditMs}`
        ].filter(Boolean).join(', ');
        res.setHeader('X-Server-Timing', timingHeader);
    }

    const soldSerials = (saleData.items || []).flatMap((item) => (Array.isArray(item.serialNumbers) ? item.serialNumbers : []).map((s) => (s && String(s).trim()) || '').filter(Boolean));
    for (const serial of soldSerials) {
        serialIndexService.upsertSerialIndex(tenantId, {
            serial,
            status: 'sold',
            saleId: sale._id,
            saleReferenceSnapshot: refLabel || sale.reference || '',
            customerNameSnapshot: (sale.customerName != null ? String(sale.customerName) : '') || '',
        }).catch(() => {});
    }

    // Sync StockItem (denormalized typeahead index): mark serial rows sold,
    // decrement non-serial qty per line. Failure is non-fatal — backfill heals drift.
    if (soldSerials.length > 0) {
        stockItemService.markSold(soldSerials, {
            tenantId,
            saleId: sale._id,
            customerName: sale.customerName || '',
            saleReference: refLabel || sale.reference || ''
        }).catch(() => {});
    }
    for (const item of (saleData.items || [])) {
        const serials = Array.isArray(item.serialNumbers) ? item.serialNumbers : [];
        if (serials.length > 0) continue; // serials handled above
        const qty = Number(item.quantity) || 0;
        if (qty > 0 && item.purchaseId && item.purchaseItemId) {
            stockItemService.decrementNonSerialQty(tenantId, item.purchaseId, item.purchaseItemId, qty).catch(() => {});
        }
    }
    stockItemService.invalidateTypeaheadCache && stockItemService.invalidateTypeaheadCache(tenantId);
    require('./purchaseController').invalidateTypeaheadCache?.(tenantId);

    // [Inventory snapshot] Print inventory state for every line on this invoice:
    //   product, qty sold this sale, serials (if any), and remaining stock left.
    try {
        const allLines = (saleData.items || []);
        if (allLines.length > 0) {
            const mongoose = require('mongoose');
            const linesWithPurchase = allLines.filter((i) => i.purchaseId && i.purchaseItemId);
            const purchaseIds = [...new Set(linesWithPurchase.map((i) => String(i.purchaseId)))]
                .map((id) => new mongoose.Types.ObjectId(id));
            const purchases = purchaseIds.length > 0
                ? await Purchase.find({ _id: { $in: purchaseIds } })
                    .select('items._id items.quantity items.name')
                    .lean()
                : [];
            const remainingByKey = new Map();
            for (const p of purchases) {
                for (const it of (p.items || [])) {
                    remainingByKey.set(`${p._id}\t${it._id}`, Number(it.quantity) || 0);
                }
            }
            const skus = [...new Set(allLines.map((i) => i.sku).filter(Boolean))];
            const soldAgg = skus.length > 0
                ? await Sale.aggregate([
                    { $match: { tenantId, status: { $ne: 'voided' }, 'items.sku': { $in: skus } } },
                    { $unwind: '$items' },
                    { $match: { 'items.sku': { $in: skus } } },
                    { $group: { _id: '$items.sku', sold: { $sum: '$items.quantity' } } }
                ])
                : [];
            const soldBySku = new Map(soldAgg.map((r) => [r._id, Number(r.sold) || 0]));
            const snapshot = allLines.map((i) => {
                const serials = Array.isArray(i.serialNumbers) ? i.serialNumbers.filter(Boolean) : [];
                const isSerial = serials.length > 0;
                const key = (i.purchaseId && i.purchaseItemId) ? `${i.purchaseId}\t${i.purchaseItemId}` : null;
                const remaining = key && remainingByKey.has(key) ? remainingByKey.get(key) : null;
                const totalSold = soldBySku.get(i.sku) || 0;
                const purchased = (remaining != null) ? remaining + totalSold : null;
                return {
                    name: i.name,
                    sku: i.sku,
                    type: isSerial ? 'serial' : 'non-serial',
                    soldThisSale: Number(i.quantity) || 0,
                    serials: isSerial ? serials : undefined,
                    purchased,
                    soldTotal: totalSold,
                    remaining
                };
            });
            console.info('[Invoice sold]', {
                reference: sale.reference,
                customer: sale.customerName || null,
                totalItems: snapshot.length,
                totalQty: snapshot.reduce((s, l) => s + l.soldThisSale, 0),
                lines: snapshot
            });
        }
    } catch (err) {
        console.warn('[Invoice sold] snapshot failed:', err.message);
    }

    await invalidateSalesCaches(tenantId);
    await cache.bumpNs('paymentAccounts:list', tenantId);
    await cache.bumpNs('customers:list', tenantId);

    res.status(201).json({
        success: true,
        message: 'Sale recorded successfully',
        data: {
            _id: sale._id.toString(),
            reference: sale.reference
        }
    });
});

// @desc    Get return-eligible lines for a sale (qty purchased, already returned, returnable)
// @route   GET /api/sales/:id/return-lines
// @access  Private
exports.getReturnLines = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const sale = await Sale.findOne({ _id: req.params.id, tenantId }).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    const reference = (sale.reference || '').trim();
    const returnsForInvoice = reference
        ? await SalesReturn.find({ linkedInvoiceRef: reference, tenantId }).lean()
        : [];

    const returnedBySku = {}; // sku -> { qty, serials }
    for (const ret of returnsForInvoice) {
        for (const it of ret.items || []) {
            const key = (it.product || '').trim();
            if (!key) continue;
            if (!returnedBySku[key]) returnedBySku[key] = { qty: 0, serials: [] };
            returnedBySku[key].qty += Math.max(0, Number(it.quantity) || 0);
            const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers : [];
            returnedBySku[key].serials.push(...serials.filter(Boolean));
        }
    }

    const lines = (sale.items || []).map((item, idx) => {
        const name = (item.name || '').trim();
        const qtyPurchased = Math.max(0, Number(item.quantity) || 0);
        const ret = returnedBySku[name] || { qty: 0, serials: [] };
        const qtyAlreadyReturned = ret.qty;
        const soldSerials = Array.isArray(item.serialNumbers) ? item.serialNumbers.filter(Boolean) : [];
        const returnableSerials = soldSerials.filter((s) => !ret.serials.includes(s));
        const qtyReturnable = soldSerials.length > 0
            ? returnableSerials.length
            : Math.max(0, qtyPurchased - qtyAlreadyReturned);

        return {
            lineIndex: idx,
            sku: item.sku,
            name: item.name || '',
            price: round2(Number(item.price) || 0),
            quantity: qtyPurchased,
            qtyAlreadyReturned,
            qtyReturnable,
            serialNumbers: soldSerials,
            returnableSerials,
        };
    });

    res.status(200).json({
        success: true,
        data: {
            saleId: sale._id.toString(),
            reference: sale.reference,
            customerName: sale.customerName,
            lines,
        },
    });
});

// @desc    Find sale and line by serial number (for scan-to-return)
// @route   GET /api/sales/find-by-serial/:serial
// @access  Private
exports.getFindBySerial = asyncHandler(async (req, res) => {
    const serial = (req.params.serial || '').trim();
    if (!serial) {
        return res.status(400).json({ success: false, message: 'Serial number is required' });
    }
    const tenantId = getTenantIdFromReq(req);
    const sold = await SoldSerial.findOne({ serialNumber: serial, status: { $ne: 'returned' } }).populate('saleId').lean();
    if (!sold || !sold.saleId) {
        return res.status(404).json({
            success: false,
            message: 'Serial not sold / already returned / not found',
        });
    }
    const sale = sold.saleId;
    if (sale.status === 'voided') {
        return res.status(404).json({
            success: false,
            message: 'Serial not sold / already returned / not found',
        });
    }
    if (sale.tenantId && sale.tenantId !== tenantId) {
        return res.status(404).json({ success: false, message: 'Serial not found' });
    }
    const items = sale.items || [];
    const lineIndex = items.findIndex((i) => Array.isArray(i.serialNumbers) && i.serialNumbers.includes(serial));
    if (lineIndex === -1) {
        return res.status(404).json({ success: false, message: 'Serial not found on sale' });
    }
    const line = items[lineIndex];
    res.status(200).json({
        success: true,
        data: {
            saleId: sale._id.toString(),
            reference: sale.reference,
            customerName: sale.customerName,
            lineIndex,
            line: {
                sku: line.sku,
                name: line.name,
                price: round2(Number(line.price) || 0),
                quantity: line.quantity,
                serialNumbers: line.serialNumbers || [],
            },
            serial,
        },
    });
});

// @desc    Take a follow-up partial payment against an existing sale.
//          Bumps the matching `payments` bucket, lowers `amountDue`, appends to `paymentHistory`,
//          and writes a payment-ledger entry so the customer statement stays in sync.
// @route   POST /api/sales/:id/take-payment
// @access  Private (sale.edit)
exports.takePayment = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const saleQuery = tenantId === 'default'
        ? { _id: req.params.id, $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] }
        : { _id: req.params.id, tenantId };
    const sale = await Sale.findOne(saleQuery);
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    if (sale.status === 'voided') {
        return res.status(400).json({ success: false, message: 'Cannot take payment on a voided sale' });
    }

    // Location scope check (same pattern as repair takePayment)
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && sale.locationId) {
        const saleLocationId = sale.locationId.toString ? sale.locationId.toString() : String(sale.locationId);
        if (!userScope.includes(saleLocationId)) {
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }
    }

    const amount = round2(req.body.amount);
    const method = (req.body.paymentMethod || req.body.method || 'cash').toLowerCase();
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const validMethods = ['cash', 'card', 'credit', 'bank'];
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'A positive amount is required' });
    }
    if (!validMethods.includes(method)) {
        return res.status(400).json({ success: false, message: 'paymentMethod must be one of cash, card, credit, bank' });
    }

    const currentDue = round2(sale.amountDue || 0);
    // For retail sales (no recorded amountDue), allow take-payment only if the sale already used "credit" payment.
    // For wholesale, amountDue is the authoritative balance.
    const allowedMax = currentDue > 0 ? currentDue : Number.POSITIVE_INFINITY;
    const applied = Math.min(amount, allowedMax);

    // Update payment bucket and lower the balance.
    sale.payments = sale.payments || {};
    sale.payments[method] = round2((Number(sale.payments[method]) || 0) + applied);
    if (currentDue > 0) {
        sale.amountDue = round2(Math.max(0, currentDue - applied));
    }
    sale.paymentHistory = Array.isArray(sale.paymentHistory) ? sale.paymentHistory : [];
    sale.paymentHistory.push({
        amount: applied,
        method,
        note,
        receivedBy: req.user?._id || null,
        receivedAt: new Date()
    });
    await sale.save();

    await invalidateSalesCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Payment recorded',
        data: {
            saleId: sale._id.toString(),
            reference: sale.reference,
            applied,
            amountDue: round2(sale.amountDue || 0),
            payments: sale.payments,
            paymentHistory: sale.paymentHistory
        }
    });
});
