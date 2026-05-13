/**
 * Create a purchase return (used by purchase return controller and by sales return when "return to supplier").
 * Payload: { purchaseId, date?, note?, items: [{ purchaseItemId, quantityReturned?, imeisReturned? }] }
 * Optionally pass actorName for SerialHistory (when not from req).
 */
const PurchaseReturn = require('../models/PurchaseReturn');
const Purchase = require('../models/Purchase');
const SerialHistory = require('../models/SerialHistory');
const activityLogService = require('../services/activityLogService');
const { purchasePartyLabel } = require('../utils/supplierDisplay');

/** Format: PR-000001, PR-000002, ... (6-digit sequence). Scoped by tenantId. */
async function getNextReturnNumber(tenantId) {
    const tid = tenantId || 'default';
    const last = await PurchaseReturn.findOne({ tenantId: tid, returnNumber: /^PR-\d{6}$/ })
        .sort({ returnNumber: -1 })
        .select('returnNumber')
        .lean();
    let seq = 1;
    if (last && last.returnNumber) {
        const match = last.returnNumber.match(/^PR-(\d{6})$/);
        if (match) seq = parseInt(match[1], 10) + 1;
    }
    return `PR-${String(seq).padStart(6, '0')}`;
}

/**
 * @param {string} userId - createdBy
 * @param {Object} payload - { purchaseId, date?, note?, items: [{ purchaseItemId, quantityReturned?, imeisReturned? }] }
 * @param {Object} [options] - { actorName?, req? } - actorName for history; req for activityLogService.logFromReq
 * @returns {Promise<{ purchaseReturn, data }>}
 */
async function createPurchaseReturn(userId, payload, options = {}) {
    const { purchaseId, date, note, items, tenantId: payloadTenantId } = payload;
    const { actorName: optionsActorName, req, tenantId: optionsTenantId } = options;
    const tenantId = payloadTenantId || optionsTenantId || 'default';

    if (!purchaseId || !items || !Array.isArray(items) || items.length === 0) {
        throw new Error('purchaseId and at least one item (purchaseItemId + quantityReturned or imeisReturned) are required');
    }

    const purchase = await Purchase.findOne({ _id: purchaseId, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account', 'name contactPerson contactName')
        .lean();

    if (!purchase) {
        throw new Error('Purchase not found');
    }

    const purchaseItems = purchase.items || [];
    const returnLines = [];
    let totalAmount = 0;

    for (const line of items) {
        const purchaseItemId = line.purchaseItemId;
        const quantityReturned = Math.max(0, parseInt(line.quantityReturned, 10) || 0);
        const imeisReturned = Array.isArray(line.imeisReturned) ? line.imeisReturned.map((s) => String(s).trim()).filter(Boolean) : [];

        const item = purchaseItems.find((i) => String(i._id) === String(purchaseItemId));
        if (!item) {
            throw new Error(`Item ${purchaseItemId} not found in this purchase`);
        }

        const isOther = item.isOtherItem === true;
        const price = Number(item.purchasePrice) || 0;

        if (isOther) {
            const maxQty = Number(item.quantity) || 0;
            if (quantityReturned <= 0 || quantityReturned > maxQty) {
                throw new Error(`Invalid quantity to return for item (max ${maxQty})`);
            }
            returnLines.push({
                purchaseItemId: item._id,
                quantityReturned,
                imeisReturned: [],
                purchasePrice: price
            });
            totalAmount += price * quantityReturned;
        } else {
            const imeis = (item.imeis || []).map((s) => String(s).trim()).filter(Boolean);
            const toReturn = imeisReturned.length ? imeisReturned : [];
            const invalid = toReturn.filter((imei) => !imeis.includes(imei));
            if (invalid.length) {
                throw new Error(`IMEI(s) not in this purchase item: ${invalid.join(', ')}`);
            }
            if (toReturn.length === 0) {
                throw new Error('Serial item requires at least one IMEI in imeisReturned');
            }
            returnLines.push({
                purchaseItemId: item._id,
                quantityReturned: 0,
                imeisReturned: toReturn,
                purchasePrice: price
            });
            totalAmount += price * toReturn.length;
        }
    }

    const returnNumber = await getNextReturnNumber(tenantId);
    const purchaseReturn = await PurchaseReturn.create({
        tenantId,
        returnNumber,
        purchase: purchaseId,
        date: date ? new Date(date) : new Date(),
        status: 'Pending',
        note: note || '',
        items: returnLines,
        totalAmount,
        createdBy: userId
    });

    const purchaseDoc = await Purchase.findOne({ _id: purchaseId, tenantId });
    if (!purchaseDoc) {
        throw new Error('Purchase not found on deduct');
    }

    for (const line of returnLines) {
        const item = (purchaseDoc.items || []).find((i) => String(i._id) === String(line.purchaseItemId));
        if (!item) continue;
        if (item.isOtherItem) {
            item.quantity = Math.max(0, (Number(item.quantity) || 0) - line.quantityReturned);
        } else {
            const existing = (item.imeis || []).map((s) => String(s).trim());
            const toRemove = new Set(line.imeisReturned || []);
            item.imeis = existing.filter((imei) => !toRemove.has(imei));
        }
    }

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

    const supplierName = purchasePartyLabel(purchase) || 'Supplier';
    const actorName = optionsActorName || '';
    const historyDocs = [];
    for (const line of returnLines) {
        const item = purchaseItems.find((i) => String(i._id) === String(line.purchaseItemId));
        const productName = item
            ? (item.name && String(item.name).trim()) || [item.brand, item.brandModel].filter(Boolean).join(' ').trim() || 'Product'
            : 'Product';
        for (const imei of (line.imeisReturned || [])) {
            historyDocs.push({
                serialNumber: String(imei).trim(),
                eventType: 'returned_to_supplier',
                referenceType: 'PurchaseReturn',
                referenceId: purchaseReturn._id,
                referenceLabel: returnNumber,
                returnDestination: 'repair',
                productName,
                returnReason: (note && String(note).trim()) || '',
                returnTo: supplierName,
                actorName
            });
        }
    }
    if (historyDocs.length > 0) {
        await SerialHistory.insertMany(historyDocs);
    }

    if (req) {
        await activityLogService.logFromReq(req, {
            action: 'PURCHASE_RETURN_CREATED',
            entityType: 'PurchaseReturn',
            entityId: purchaseReturn._id,
            success: true,
            message: `Purchase return ${returnNumber} created for purchase ${purchase.purchaseNumber || purchaseId}`,
            metaJson: { returnNumber, purchaseId, totalAmount }
        });
    }

    const populated = await PurchaseReturn.findById(purchaseReturn._id)
        .populate('purchase', 'purchaseNumber date status grandTotal')
        .populate('createdBy', 'name')
        .lean();

    const data = {
        ...populated,
        supplierName,
        purchaseNumber: purchase.purchaseNumber
    };
    return { purchaseReturn, data };
}

module.exports = {
    createPurchaseReturn,
    getNextReturnNumber
};
