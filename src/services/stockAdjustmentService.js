/**
 * Stock Adjustment service: adjustment no, cost snapshot, serial validation, post/cancel with ledger.
 * Uses existing Location, StockMove, StockBalance, SerialLocation. No direct stock edits.
 */

const StockAdjustment = require('../models/StockAdjustment');
const StockMove = require('../models/StockMove');
const SerialLocation = require('../models/SerialLocation');
const StockBalance = require('../models/StockBalance');
const SoldSerial = require('../models/SoldSerial');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');

const STATUS = { DRAFT: 'Draft', POSTED: 'Posted', CANCELLED: 'Cancelled' };

function normalizeSerial(s) {
    return String(s).trim();
}

async function generateAdjustmentNo(tenantId) {
    const tid = tenantId || 'default';
    const last = await StockAdjustment.findOne({ tenantId: tid }).sort({ adjustmentNo: -1 }).select('adjustmentNo').lean();
    const match = last && last.adjustmentNo ? last.adjustmentNo.match(/^SA-(\d+)$/i) : null;
    const next = match ? parseInt(match[1], 10) + 1 : 1;
    return `SA-${String(next).padStart(5, '0')}`;
}

/**
 * Resolve unit cost for a product (qty line). Prefer Purchase item at location, else Product.costPrice. Scoped by tenantId.
 */
async function resolveCostForProduct(productId, locationId, tenantId) {
    const tid = tenantId || 'default';
    const product = await Product.findOne({ _id: productId, tenantId: tid }).select('costPrice barcode sku').lean();
    if (!product) return { cost: 0, costMissing: true };
    let cost = Number(product.costPrice) || 0;
    let costMissing = false;
    const purchases = await Purchase.find({ tenantId: tid, 'items.sendTo': locationId })
        .select('items.purchasePrice items.barcode items.sku')
        .sort('-createdAt')
        .limit(50)
        .lean();
    for (const purchase of purchases) {
        if (!purchase.items) continue;
        const item = purchase.items.find(
            (i) => (product.barcode && i.barcode === product.barcode) || (i.sku === product.sku)
        );
        if (item && item.purchasePrice != null) {
            cost = Number(item.purchasePrice);
            break;
        }
    }
    return { cost, costMissing };
}

/**
 * Resolve unit cost for a serial from Purchase item containing this IMEI. Scoped by tenantId.
 */
async function resolveCostForSerial(serialNumber, tenantId) {
    const serial = normalizeSerial(serialNumber);
    const tid = tenantId || 'default';
    const purchase = await Purchase.findOne({ tenantId: tid, 'items.imeis': serial })
        .select('items.purchasePrice items.imeis')
        .lean();
    if (!purchase || !purchase.items) return { cost: 0, costMissing: true };
    for (const it of purchase.items) {
        const imeis = (it.imeis || []).map((x) => String(x).trim());
        if (imeis.includes(serial)) {
            const cost = Number(it.purchasePrice) || 0;
            return { cost, costMissing: false };
        }
    }
    return { cost: 0, costMissing: true };
}

/**
 * Resolve productId for a serial (from Purchase by IMEI, then Product by barcode/sku). Scoped by tenantId.
 */
async function resolveProductForSerial(serialNumber, tenantId) {
    const serial = normalizeSerial(serialNumber);
    const tid = tenantId || 'default';
    const purchase = await Purchase.findOne({ tenantId: tid, 'items.imeis': serial })
        .select('items.barcode items.sku items.imeis')
        .lean();
    if (!purchase || !purchase.items) return null;
    for (const it of purchase.items) {
        const imeis = (it.imeis || []).map((x) => String(x).trim());
        if (!imeis.includes(serial)) continue;
        if (it.sku) {
            const p = await Product.findOne({ tenantId: tid, sku: it.sku }).select('_id').lean();
            if (p) return p._id;
        }
        if (it.barcode) {
            const p = await Product.findOne({ tenantId: tid, barcode: it.barcode }).select('_id').lean();
            if (p) return p._id;
        }
    }
    return null;
}

/**
 * Validate serial for adjustment. direction IN | OUT. Scoped by tenantId.
 * OUT: must exist at location, available (not sold, not in_transfer, not already in this adjustment).
 * IN: must not already exist as available or in_transfer (allow re-add if adjusted_out).
 */
async function validateSerialForAdjustment(serialNumber, locationId, direction, excludeAdjustmentId = null, tenantId) {
    const serial = normalizeSerial(serialNumber);
    if (!serial) return { valid: false, reason: 'Serial is empty' };
    const tid = tenantId || 'default';
    const locId = locationId && locationId.toString ? locationId.toString() : locationId;

    if (direction === 'OUT') {
        const sold = await SoldSerial.findOne({ serialNumber: serial }).select('_id').lean();
        if (sold) return { valid: false, reason: 'Serial is sold' };

        const inOtherAdjustment = await StockAdjustment.findOne({
            tenantId: tid,
            _id: excludeAdjustmentId ? { $ne: excludeAdjustmentId } : { $exists: true },
            status: STATUS.DRAFT,
            'serials.serialOrImei': serial
        }).select('_id adjustmentNo').lean();
        if (inOtherAdjustment) return { valid: false, reason: 'Serial already in another draft adjustment' };

        const sl = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).lean();
        if (!sl) return { valid: false, reason: 'Serial not found at any location' };
        if (sl.status !== 'available') return { valid: false, reason: 'Serial is not available (in transfer or already adjusted out)' };
        if (sl.locationId && sl.locationId.toString() !== locId) return { valid: false, reason: 'Serial is at a different location' };
        const productId = await resolveProductForSerial(serial, tid);
        return { valid: true, productId: productId || undefined };
    }

    if (direction === 'IN') {
        const sl = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).lean();
        if (sl && (sl.status === 'available' || sl.status === 'in_transfer')) {
            return { valid: false, reason: 'Serial already exists in stock (duplicate)' };
        }
        const productId = await resolveProductForSerial(serial, tid);
        return { valid: true, productId: productId || undefined };
    }

    return { valid: false, reason: 'Invalid direction' };
}

function getBalance(productId, locationId, tenantId) {
    const tid = tenantId || 'default';
    return StockBalance.findOne({ tenantId: tid, productId, locationId }).select('quantity').lean()
        .then((b) => (b && b.quantity) || 0);
}

/**
 * Recompute totals on the adjustment document (totals only; lines/serials already set).
 */
function computeTotals(adj) {
    let totalQtyIn = 0, totalQtyOut = 0, totalValueIn = 0, totalValueOut = 0;
    for (const line of adj.lines || []) {
        if (line.deltaQty > 0) {
            totalQtyIn += line.deltaQty;
            totalValueIn += line.valueSnapshot || 0;
        } else {
            totalQtyOut += Math.abs(line.deltaQty);
            totalValueOut += line.valueSnapshot || 0;
        }
    }
    for (const ser of adj.serials || []) {
        if (ser.direction === 'IN') {
            totalQtyIn += 1;
            totalValueIn += ser.valueSnapshot || 0;
        } else {
            totalQtyOut += 1;
            totalValueOut += ser.valueSnapshot || 0;
        }
    }
    return { totalQtyIn, totalQtyOut, totalValueIn, totalValueOut };
}

/**
 * Post adjustment: create StockMoves, update StockBalance and SerialLocation. Run in session (transaction). Scoped by tenantId.
 * @param {Object} [opts] - { allowCostMissingOverride: true } to allow posting when lines have costMissing (manager override).
 */
async function postAdjustment(adjustmentId, tenantId, userId, session, opts = {}) {
    const tid = tenantId || 'default';
    const allowCostMissingOverride = opts.allowCostMissingOverride === true;
    const adjustment = await StockAdjustment.findOne({ _id: adjustmentId, tenantId: tid }).session(session);
    if (!adjustment) throw new Error('Adjustment not found');
    if (adjustment.status !== STATUS.DRAFT) throw new Error('Only draft adjustments can be posted');
    const locationId = adjustment.locationId;

    const hasCostMissing = [...(adjustment.lines || []), ...(adjustment.serials || [])]
        .some((x) => x.costMissing === true);
    if (hasCostMissing && !allowCostMissingOverride) {
        throw new Error('One or more lines have missing cost. Resolve cost or use override_missing_cost permission.');
    }

    for (const line of adjustment.lines || []) {
        const balance = await getBalance(line.productId, locationId, tid);
        if (line.deltaQty < 0 && balance < Math.abs(line.deltaQty)) {
            const product = await Product.findOne({ _id: line.productId, tenantId: tid }).select('name sku').lean();
            const name = product ? (product.name || product.sku) : line.productId;
            throw new Error(`Insufficient stock for ${name}: available ${balance}, adjustment out ${Math.abs(line.deltaQty)}`);
        }
    }

    for (const ser of adjustment.serials || []) {
        const check = await validateSerialForAdjustment(ser.serialOrImei, locationId, ser.direction, adjustmentId, tid);
        if (!check.valid) throw new Error(`Serial ${ser.serialOrImei}: ${check.reason}`);
    }

    const now = new Date();

    for (const line of adjustment.lines || []) {
        const moveType = line.deltaQty > 0 ? 'adjust_in' : 'adjust_out';
        const qty = Math.abs(line.deltaQty);
        await StockMove.create([{
            tenantId: tid,
            adjustmentId,
            type: moveType,
            locationId,
            productId: line.productId,
            quantity: qty,
            serialNumber: null
        }], { session });
        await StockBalance.findOneAndUpdate(
            { tenantId: tid, productId: line.productId, locationId },
            { $inc: { quantity: line.deltaQty } },
            { upsert: true, new: true, session }
        );
    }

    for (const ser of adjustment.serials || []) {
        const serial = normalizeSerial(ser.serialOrImei);
        const moveType = ser.direction === 'IN' ? 'adjust_in' : 'adjust_out';
        await StockMove.create([{
            tenantId: tid,
            adjustmentId,
            type: moveType,
            locationId,
            productId: ser.productId || null,
            quantity: null,
            serialNumber: serial
        }], { session });

        if (ser.direction === 'OUT') {
            await SerialLocation.updateOne(
                { tenantId: tid, serialNumber: serial },
                { $set: { status: 'adjusted_out', adjustmentId } },
                { session }
            );
        } else {
            const existing = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).session(session);
            if (existing) {
                await SerialLocation.updateOne(
                    { tenantId: tid, serialNumber: serial },
                    { $set: { locationId, status: 'available', adjustmentId, transferId: null, productId: ser.productId || null } },
                    { session }
                );
            } else {
                await SerialLocation.create([{
                    tenantId: tid,
                    serialNumber: serial,
                    locationId,
                    status: 'available',
                    adjustmentId,
                    productId: ser.productId || null
                }], { session });
            }
        }
    }

    const totals = computeTotals(adjustment);
    adjustment.status = STATUS.POSTED;
    adjustment.postedByUserId = userId;
    adjustment.postedAtUtc = now;
    adjustment.totalQtyIn = totals.totalQtyIn;
    adjustment.totalQtyOut = totals.totalQtyOut;
    adjustment.totalValueIn = totals.totalValueIn;
    adjustment.totalValueOut = totals.totalValueOut;
    await adjustment.save({ session });
    return adjustment;
}

/**
 * Cancel adjustment. Only Draft can be cancelled (no reversal for Posted). Scoped by tenantId.
 */
async function cancelAdjustment(adjustmentId, userId, session, tenantId) {
    const tid = tenantId || 'default';
    const adjustment = await StockAdjustment.findOne({ _id: adjustmentId, tenantId: tid }).session(session);
    if (!adjustment) throw new Error('Adjustment not found');
    if (adjustment.status !== STATUS.DRAFT) {
        throw new Error('Only draft adjustments can be cancelled. Posted adjustments cannot be reversed.');
    }
    const now = new Date();
    adjustment.status = STATUS.CANCELLED;
    adjustment.cancelledByUserId = userId;
    adjustment.cancelledAtUtc = now;
    await adjustment.save({ session });
    return adjustment;
}

const REASON_CODES = require('../models/StockAdjustment').REASON_CODES || ['COUNT_CORRECTION', 'DAMAGED', 'LOST_STOLEN', 'SUPPLIER_DISCREPANCY', 'DATA_FIX', 'OTHER'];

module.exports = {
    STATUS,
    REASON_CODES,
    generateAdjustmentNo,
    normalizeSerial,
    resolveCostForProduct,
    resolveCostForSerial,
    resolveProductForSerial,
    validateSerialForAdjustment,
    computeTotals,
    postAdjustment,
    cancelAdjustment
};
