/**
 * Stock Transfer service: transfer_no generation, serial validation, dispatch/receive with stock moves.
 * Uses existing Location model. Ledger: append-only StockMove; SerialLocation tracks serial position.
 */

const mongoose = require('mongoose');
const StockTransfer = require('../models/StockTransfer');
const StockMove = require('../models/StockMove');
const SerialLocation = require('../models/SerialLocation');
const StockBalance = require('../models/StockBalance');
const SoldSerial = require('../models/SoldSerial');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');

const STATUS = { DRAFT: 'Draft', DISPATCHED: 'Dispatched', RECEIVED: 'Received', CANCELLED: 'Cancelled' };

/**
 * Generate next transfer_no (e.g. ST-00001). Scoped by tenantId. Not transaction-safe; use with unique index.
 */
async function generateTransferNo(tenantId) {
    const tid = tenantId || 'default';
    const last = await StockTransfer.findOne({ tenantId: tid }).sort({ transferNo: -1 }).select('transferNo').lean();
    const match = last && last.transferNo ? last.transferNo.match(/^ST-(\d+)$/i) : null;
    const next = match ? parseInt(match[1], 10) + 1 : 1;
    return `ST-${String(next).padStart(5, '0')}`;
}

/**
 * Normalize serial for lookup (trim, uppercase if needed).
 */
function normalizeSerial(s) {
    return String(s).trim();
}

/**
 * Resolve product ID for a serial from SerialLocation or Purchase. Scoped by tenantId.
 */
async function resolveProductForSerial(serialNumber, tenantId) {
    const serial = normalizeSerial(serialNumber);
    const tid = tenantId || 'default';
    const sl = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).select('serialNumber').lean();
    if (sl) {
        // SerialLocation doesn't store productId; we need Purchase or a product reference. For now we look up from Purchase.
    }
    const purchase = await Purchase.findOne({ tenantId: tid, 'items.imeis': serial }).select('items.barcode items.imeis items.sku').lean();
    if (purchase && purchase.items) {
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
    }
    return null;
}

/**
 * Validate serial can be added to transfer: exists, available, at from_location, not already in this or another open transfer.
 * Returns { valid: boolean, reason?: string, productId?: ObjectId }. Scoped by tenantId.
 */
async function validateSerialForTransfer(serialNumber, fromLocationId, excludeTransferId = null, tenantId) {
    const serial = normalizeSerial(serialNumber);
    if (!serial) return { valid: false, reason: 'Serial is empty' };
    const tid = tenantId || 'default';
    const fromId = fromLocationId && fromLocationId.toString ? fromLocationId.toString() : fromLocationId;

    // Already in another open transfer (Draft or Dispatched)?
    const inOther = await StockTransfer.findOne({
        tenantId: tid,
        _id: excludeTransferId ? { $ne: excludeTransferId } : { $exists: true },
        status: { $in: [STATUS.DRAFT, STATUS.DISPATCHED] },
        'serials.serialOrImei': serial
    }).select('_id transferNo').lean();
    if (inOther) return { valid: false, reason: 'Serial already in another open transfer' };

    // Sold?
    const sold = await SoldSerial.findOne({ serialNumber: serial }).select('_id').lean();
    if (sold) return { valid: false, reason: 'Serial already sold' };

    // In SerialLocation: must be available and at from_location
    const sl = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).lean();
    if (sl) {
        if (sl.status !== 'available') return { valid: false, reason: 'Serial is in transfer or not available' };
        if (sl.locationId && sl.locationId.toString() !== fromId) return { valid: false, reason: 'Serial is at a different location' };
        const productId = await resolveProductForSerial(serial, tid);
        return { valid: true, productId: productId || undefined };
    }

    // Not in SerialLocation: check Purchase (sendTo = from_location)
    const purchase = await Purchase.findOne({ tenantId: tid, 'items.imeis': serial }).select('items.sendTo items.imeis items.sku').lean();
    if (!purchase || !purchase.items) return { valid: false, reason: 'Serial not found' };
    let atFrom = false;
    let productId = null;
    for (const it of purchase.items) {
        const imeis = (it.imeis || []).map((x) => String(x).trim());
        if (!imeis.includes(serial)) continue;
        const sendToId = it.sendTo && it.sendTo.toString ? it.sendTo.toString() : (it.sendTo && it.sendTo._id ? it.sendTo._id.toString() : null);
        if (sendToId === fromId) atFrom = true;
        if (it.sku) {
            const p = await Product.findOne({ tenantId: tid, sku: it.sku }).select('_id').lean();
            if (p) productId = p._id;
        }
        break;
    }
    if (!atFrom) return { valid: false, reason: 'Serial is not at the selected from location' };
    return { valid: true, productId: productId || undefined };
}

/**
 * Get available qty of product at location (from StockBalance). Scoped by tenantId.
 */
async function getBalance(productId, locationId, tenantId) {
    const tid = tenantId || 'default';
    const b = await StockBalance.findOne({ tenantId: tid, productId, locationId }).select('quantity').lean();
    return (b && b.quantity) || 0;
}

/**
 * Get available qty for a transfer line at fromLocationId. Scoped by tenantId.
 * If line has purchaseId + purchaseItemId, use the purchase item's quantity when item.sendTo === fromLocationId.
 * Otherwise use StockBalance.
 */
async function getAvailableForLine(line, fromLocationId, tenantId) {
    const tid = tenantId || 'default';
    const fromId = fromLocationId && fromLocationId.toString ? fromLocationId.toString() : fromLocationId;
    if (line.purchaseId && line.purchaseItemId) {
        const purchase = await Purchase.findOne({ _id: line.purchaseId, tenantId: tid }).select('items').lean();
        if (!purchase || !purchase.items) return 0;
        const item = purchase.items.find((i) => String(i._id) === String(line.purchaseItemId));
        if (!item) return 0;
        const itemLocationId = (item.sendTo && item.sendTo.toString && item.sendTo.toString()) || (item.sendTo && item.sendTo._id && item.sendTo._id.toString()) || null;
        if (itemLocationId !== fromId) return 0;
        return Number(item.quantity) || 0;
    }
    return getBalance(line.productId, fromLocationId, tid);
}

/**
 * Decrement purchase item quantity (when line is inventory-sourced). Run inside transaction. Scoped by tenantId.
 * Uses $elemMatch so the update only runs when item quantity >= qty (avoids going negative).
 */
async function decrementPurchaseItemQuantity(purchaseId, purchaseItemId, qty, session, tenantId) {
    const tid = tenantId || 'default';
    const result = await Purchase.findOneAndUpdate(
        { _id: purchaseId, tenantId: tid, items: { $elemMatch: { _id: purchaseItemId, quantity: { $gte: qty } } } },
        { $inc: { 'items.$.quantity': -qty } },
        { new: true, session }
    );
    if (!result) {
        throw new Error('Insufficient quantity on purchase item (concurrent update or quantity changed)');
    }
    return result;
}

/**
 * Dispatch transfer: create OUT stock moves, mark serials in_transfer, decrement StockBalance for lines.
 * Must run in a session (transaction). Scoped by tenantId.
 */
async function dispatchTransfer(transferId, userId, session, tenantId) {
    const tid = tenantId || 'default';
    const transfer = await StockTransfer.findOne({ _id: transferId, tenantId: tid }).session(session);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status !== STATUS.DRAFT) throw new Error('Only draft transfers can be dispatched');
    const fromLocationId = transfer.fromLocationId;
    const toLocationId = transfer.toLocationId;

    // Validate qty lines: sufficient stock at from_location (StockBalance or purchase item)
    for (const line of transfer.lines || []) {
        const available = await getAvailableForLine(line, fromLocationId, tid);
        if (available < line.qty) {
            const product = await Product.findOne({ _id: line.productId, tenantId: tid }).select('name sku').lean();
            const name = product ? (product.name || product.sku) : line.productId;
            throw new Error(`Insufficient stock at from-location for ${name}: available ${available}, required ${line.qty}`);
        }
    }

    // Validate serials: each at from_location and available (again under lock)
    for (const ser of transfer.serials || []) {
        const check = await validateSerialForTransfer(ser.serialOrImei, fromLocationId, transferId, tid);
        if (!check.valid) throw new Error(`Serial ${ser.serialOrImei}: ${check.reason}`);
    }

    const now = new Date();

    // Create OUT moves for qty lines, update StockBalance, and deduct from purchase item when applicable
    for (const line of transfer.lines || []) {
        if (line.purchaseId && line.purchaseItemId) {
            await decrementPurchaseItemQuantity(line.purchaseId, line.purchaseItemId, line.qty, session, tid);
        }
        await StockMove.create([{
            tenantId: tid,
            transferId,
            type: 'out',
            locationId: fromLocationId,
            productId: line.productId,
            quantity: line.qty,
            serialNumber: null
        }], { session });
        await StockBalance.findOneAndUpdate(
            { tenantId: tid, productId: line.productId, locationId: fromLocationId },
            { $inc: { quantity: -line.qty } },
            { upsert: true, new: true, session }
        );
    }

    // Create OUT moves for serials and set SerialLocation to in_transfer (create if from Purchase only)
    for (const ser of transfer.serials || []) {
        const serial = normalizeSerial(ser.serialOrImei);
        await StockMove.create([{
            tenantId: tid,
            transferId,
            type: 'out',
            locationId: fromLocationId,
            productId: ser.productId || null,
            quantity: null,
            serialNumber: serial
        }], { session });
        const existing = await SerialLocation.findOne({ tenantId: tid, serialNumber: serial }).session(session);
        if (existing) {
            await SerialLocation.updateOne(
                { tenantId: tid, serialNumber: serial },
                { $set: { status: 'in_transfer', transferId } },
                { session }
            );
        } else {
            await SerialLocation.create([{
                tenantId: tid,
                serialNumber: serial,
                locationId: fromLocationId,
                status: 'in_transfer',
                transferId,
                productId: ser.productId || null
            }], { session });
        }
    }

    transfer.status = STATUS.DISPATCHED;
    transfer.dispatchedByUserId = userId;
    transfer.dispatchedAtUtc = now;
    await transfer.save({ session });
    return transfer;
}

/**
 * Receive transfer: create IN stock moves, move serials to to_location, increment StockBalance.
 * Must run in a session (transaction). Scoped by tenantId.
 */
async function receiveTransfer(transferId, userId, session, tenantId) {
    const tid = tenantId || 'default';
    const transfer = await StockTransfer.findOne({ _id: transferId, tenantId: tid }).session(session);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status !== STATUS.DISPATCHED) throw new Error('Only dispatched transfers can be received');
    const toLocationId = transfer.toLocationId;

    const now = new Date();

    // IN moves for qty lines
    for (const line of transfer.lines || []) {
        await StockMove.create([{
            tenantId: tid,
            transferId,
            type: 'in',
            locationId: toLocationId,
            productId: line.productId,
            quantity: line.qty,
            serialNumber: null
        }], { session });
        await StockBalance.findOneAndUpdate(
            { tenantId: tid, productId: line.productId, locationId: toLocationId },
            { $inc: { quantity: line.qty } },
            { upsert: true, new: true, session }
        );
    }

    // IN moves for serials; update SerialLocation to to_location and available
    for (const ser of transfer.serials || []) {
        const serial = normalizeSerial(ser.serialOrImei);
        await StockMove.create([{
            tenantId: tid,
            transferId,
            type: 'in',
            locationId: toLocationId,
            productId: ser.productId || null,
            quantity: null,
            serialNumber: serial
        }], { session });
        await SerialLocation.findOneAndUpdate(
            { tenantId: tid, serialNumber: serial },
            { $set: { locationId: toLocationId, status: 'available', transferId: null, productId: ser.productId || null } },
            { session }
        );
    }

    transfer.status = STATUS.RECEIVED;
    transfer.receivedByUserId = userId;
    transfer.receivedAtUtc = now;
    await transfer.save({ session });
    return transfer;
}

/**
 * Cancel transfer: only Draft. No stock moves to reverse. Scoped by tenantId.
 */
async function cancelTransfer(transferId, session, tenantId) {
    const tid = tenantId || 'default';
    const transfer = await StockTransfer.findOne({ _id: transferId, tenantId: tid }).session(session);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status !== STATUS.DRAFT) throw new Error('Only draft transfers can be cancelled');
    transfer.status = STATUS.CANCELLED;
    await transfer.save({ session });
    return transfer;
}

module.exports = {
    STATUS,
    generateTransferNo,
    normalizeSerial,
    validateSerialForTransfer,
    resolveProductForSerial,
    getBalance,
    dispatchTransfer,
    receiveTransfer,
    cancelTransfer
};
