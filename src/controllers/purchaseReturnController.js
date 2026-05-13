const PurchaseReturn = require('../models/PurchaseReturn');
const Purchase = require('../models/Purchase');
const SerialHistory = require('../models/SerialHistory');
const asyncHandler = require('../middleware/asyncHandler');
const purchaseReturnService = require('../services/purchaseReturnService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { purchasePartyLabel } = require('../utils/supplierDisplay');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

// @route   GET /api/purchase-returns
// @access  Private (purchase.return)
exports.getPurchaseReturns = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;

    const params = {
        page, limit,
        status: req.query.status || null,
        search: req.query.search || null,
    };

    const payload = await cache.cached(
        { ns: 'purchaseReturns:list', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => {
            const query = { tenantId };
            if (req.query.status) query.status = req.query.status;
            if (req.query.search) {
                query.$or = [
                    { returnNumber: { $regex: req.query.search, $options: 'i' } }
                ];
            }

            const total = await PurchaseReturn.countDocuments(query);
            const returns = await PurchaseReturn.find(query)
                .populate('purchase', 'purchaseNumber date status paymentStatus grandTotal')
                .populate('createdBy', 'name')
                .sort('-createdAt')
                .skip(startIndex)
                .limit(limit)
                .lean();

            // Enrich with supplier/customer name from purchase (account can be Supplier or Customer)
            const purchaseIds = [...new Set(returns.map((r) => r.purchase && r.purchase._id).filter(Boolean))];
            const purchases = await Purchase.find({ tenantId, _id: { $in: purchaseIds } })
                .populate('supplier', 'name contactPerson')
                .populate('account', 'name contactPerson contactName')
                .lean();
            const purchaseMap = {};
            purchases.forEach((p) => { purchaseMap[p._id.toString()] = p; });

            const data = returns.map((r) => {
                const p = r.purchase ? purchaseMap[r.purchase._id.toString()] || r.purchase : null;
                const supplierName = (p && purchasePartyLabel(p)) || (r.purchase && r.purchase.supplierName) || '';
                return {
                    ...r,
                    supplierName,
                    purchaseNumber: (r.purchase && r.purchase.purchaseNumber) || ''
                };
            });
            return { total, data };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.data.length,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit),
        data: payload.data
    });
});

// @route   GET /api/purchase-returns/:id
// @access  Private (purchase.return)
exports.getPurchaseReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await PurchaseReturn.findOne({ _id: req.params.id, tenantId })
        .populate('purchase')
        .populate('createdBy', 'name')
        .lean();

    if (!doc) {
        return res.status(404).json({ success: false, message: 'Purchase return not found' });
    }

    if (doc.purchase && doc.purchase._id) {
        const pop = await Purchase.findOne({ _id: doc.purchase._id, tenantId })
            .populate('supplier', 'name contactPerson')
            .populate('account', 'name contactPerson contactName')
            .lean();
        if (pop) {
            doc.supplierName = purchasePartyLabel(pop) || '';
        }
    }

    res.status(200).json({ success: true, data: doc });
});

// @route   POST /api/purchase-returns
// @access  Private (purchase.return)
// Body: { purchaseId, date?, note?, items: [{ purchaseItemId, quantityReturned?, imeisReturned? }] }
exports.createPurchaseReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    if (req.body.tenantId !== undefined) delete req.body.tenantId;
    req.body.tenantId = tenantId;
    try {
        const { purchaseReturn, data } = await purchaseReturnService.createPurchaseReturn(
            req.user.id,
            req.body,
            { actorName: req.user && req.user.name ? String(req.user.name) : '', req, tenantId }
        );
        await cache.bumpMany(['purchaseReturns:list', 'purchases:list', 'paymentAccounts:list'], tenantId);
        return res.status(201).json({ success: true, data });
    } catch (err) {
        if (err.message && (err.message.includes('not found') || err.message.includes('required') || err.message.includes('Invalid'))) {
            return res.status(400).json({ success: false, message: err.message });
        }
        throw err;
    }
});

// @route   POST /api/purchase-returns/:id/receive-repair
// @access  Private (purchase.return)
// Body: { imeis: string[] } - IMEIs received back from supplier after repair; they are put back on the purchase and in stock
exports.receiveRepair = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, tenantId }).lean();
    if (!purchaseReturn) {
        return res.status(404).json({ success: false, message: 'Purchase return not found' });
    }

    const imeis = Array.isArray(req.body.imeis) ? req.body.imeis.map((s) => String(s).trim()).filter(Boolean) : [];
    if (imeis.length === 0) {
        return res.status(400).json({ success: false, message: 'imeis array with at least one serial is required' });
    }

    const purchaseId = purchaseReturn.purchase;
    if (!purchaseId) {
        return res.status(400).json({ success: false, message: 'Purchase return has no linked purchase' });
    }

    // Build set of IMEIs that are in this return (and which line they belong to)
    const imeiToItemId = {};
    for (const line of purchaseReturn.items || []) {
        for (const imei of (line.imeisReturned || [])) {
            const s = String(imei).trim();
            if (s) imeiToItemId[s] = line.purchaseItemId;
        }
    }

    const invalid = imeis.filter((imei) => !imeiToItemId[imei]);
    if (invalid.length > 0) {
        return res.status(400).json({
            success: false,
            message: `IMEI(s) not in this purchase return: ${invalid.join(', ')}. Only serials that were returned on this return can be received back.`
        });
    }

    const purchaseDoc = await Purchase.findOne({ _id: purchaseId, tenantId });
    if (!purchaseDoc) {
        return res.status(404).json({ success: false, message: 'Purchase not found' });
    }

    // Add each IMEI back to the correct purchase item
    for (const imei of imeis) {
        const purchaseItemId = imeiToItemId[imei];
        const item = (purchaseDoc.items || []).find((i) => String(i._id) === String(purchaseItemId));
        if (item && !item.isOtherItem) {
            if (!item.imeis) item.imeis = [];
            if (!item.imeis.includes(imei)) {
                item.imeis.push(imei);
            }
        }
    }

    // Recalculate purchase totals
    let totalIMEIs = 0;
    let totalOtherQuantity = 0;
    let grandTotal = 0;
    for (const it of purchaseDoc.items) {
        if (it.isOtherItem) {
            const qty = Number(it.quantity) || 0;
            totalOtherQuantity += qty;
            grandTotal += (Number(it.purchasePrice) || 0) * qty;
        } else {
            const count = (it.imeis && it.imeis.length) || 0;
            totalIMEIs += count;
            grandTotal += (Number(it.purchasePrice) || 0) * count;
        }
    }
    purchaseDoc.totalIMEIs = totalIMEIs;
    purchaseDoc.totalOtherQuantity = totalOtherQuantity;
    purchaseDoc.grandTotal = grandTotal;
    await purchaseDoc.save();

    // IMEI history: received_from_repair with product name, return-to, user for product history
    const returnNumber = purchaseReturn.returnNumber || `PR-${purchaseReturn._id}`;
    const purchaseWithSupplier = await Purchase.findOne({ _id: purchaseId, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account', 'name contactPerson contactName')
        .lean();
    const returnToName = purchaseWithSupplier ? (purchasePartyLabel(purchaseWithSupplier) || 'Supplier') : 'Supplier';
    const actorName = (req.user && req.user.name) ? String(req.user.name) : '';
    const historyDocs = imeis.map((imei) => {
        const purchaseItemId = imeiToItemId[imei];
        const item = (purchaseDoc.items || []).find((i) => String(i._id) === String(purchaseItemId));
        const productName = item
            ? (item.name && String(item.name).trim()) || [item.brand, item.brandModel].filter(Boolean).join(' ').trim() || 'Product'
            : 'Product';
        return {
            serialNumber: imei,
            eventType: 'received_from_repair',
            referenceType: 'PurchaseReturn',
            referenceId: purchaseReturn._id,
            referenceLabel: returnNumber,
            returnDestination: '',
            productName,
            returnReason: (purchaseReturn.note && String(purchaseReturn.note).trim()) || '',
            returnTo: returnToName,
            actorName
        };
    });
    await SerialHistory.insertMany(historyDocs);

    const populated = await PurchaseReturn.findById(purchaseReturn._id)
        .populate('purchase', 'purchaseNumber date status grandTotal')
        .populate('createdBy', 'name')
        .lean();

    await cache.bumpMany(['purchaseReturns:list', 'purchases:list', 'paymentAccounts:list'], tenantId);

    res.status(200).json({
        success: true,
        message: `${imeis.length} serial(s) received back from repair and put in stock`,
        data: populated
    });
});

// @route   PUT /api/purchase-returns/:id
// @access  Private (purchase.return)
// Body: { status?, note? } - only status/note updates
exports.updatePurchaseReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await PurchaseReturn.findById(req.params.id);
    if (!doc) {
        return res.status(404).json({ success: false, message: 'Purchase return not found' });
    }

    if (req.body.status !== undefined) {
        const allowed = ['Pending', 'Sent', 'Received by Supplier'];
        if (!allowed.includes(req.body.status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }
        doc.status = req.body.status;
    }
    if (req.body.note !== undefined) doc.note = req.body.note;

    await doc.save();

    const populated = await PurchaseReturn.findById(doc._id)
        .populate('purchase', 'purchaseNumber date status grandTotal')
        .populate('createdBy', 'name')
        .lean();

    await cache.bumpMany(['purchaseReturns:list', 'purchases:list', 'paymentAccounts:list'], tenantId);

    res.status(200).json({ success: true, data: populated });
});

// @route   DELETE /api/purchase-returns/:id
// @access  Private (purchase.return) - optional; not restoring stock for simplicity
exports.deletePurchaseReturn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await PurchaseReturn.findById(req.params.id);
    if (!doc) {
        return res.status(404).json({ success: false, message: 'Purchase return not found' });
    }
    await doc.deleteOne();
    await cache.bumpMany(['purchaseReturns:list', 'purchases:list', 'paymentAccounts:list'], tenantId);
    res.status(200).json({ success: true, message: 'Purchase return deleted' });
});
