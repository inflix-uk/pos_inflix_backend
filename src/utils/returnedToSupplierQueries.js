/**
 * Returned-to-supplier blocking rules.
 * Historic SerialHistory / SoldSerial return flags must NOT permanently ban a serial
 * after it is re-purchased (IMEI present again on a non-cancelled Purchase).
 */
const Purchase = require('../models/Purchase');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');

function normalizeSerialList(serials) {
    return [...new Set((serials || []).map((s) => String(s || '').trim()).filter(Boolean))];
}

/**
 * Which of `serials` currently appear on a non-cancelled purchase for this tenant.
 * @returns {Promise<Set<string>>}
 */
async function serialsCurrentlyOnPurchase(serials, tenantId, session = null) {
    const trimmed = normalizeSerialList(serials);
    if (trimmed.length === 0 || !tenantId) return new Set();
    const q = Purchase.find({
        tenantId,
        status: { $ne: 'cancelled' },
        'items.imeis': { $in: trimmed },
    }).select('items.imeis').lean();
    if (session) q.session(session);
    const purchases = await q;
    const wanted = new Set(trimmed);
    const onHand = new Set();
    for (const p of purchases || []) {
        for (const it of p.items || []) {
            for (const imei of it.imeis || []) {
                const s = String(imei || '').trim();
                if (wanted.has(s)) onHand.add(s);
            }
        }
    }
    return onHand;
}

/**
 * Among candidate serials, those blocked as returned-to-supplier (not sellable / not in stock).
 * @returns {Promise<string[]>}
 */
async function findBlockingReturnedToSupplierAmong(serials, tenantId, session = null) {
    const trimmed = normalizeSerialList(serials);
    if (trimmed.length === 0) return [];

    let historyQ = SerialHistory.find({
        serialNumber: { $in: trimmed },
        eventType: 'returned_to_supplier',
    }).select('serialNumber').lean();
    let soldQ = SoldSerial.find({
        serialNumber: { $in: trimmed },
        status: 'returned',
        returnDestination: 'return_to_supplier',
    }).select('serialNumber').lean();
    if (session) {
        historyQ = historyQ.session(session);
        soldQ = soldQ.session(session);
    }
    const [history, soldReturned] = await Promise.all([historyQ, soldQ]);
    const candidates = normalizeSerialList([
        ...(history || []).map((d) => d.serialNumber),
        ...(soldReturned || []).map((d) => d.serialNumber),
    ]);
    if (candidates.length === 0) return [];

    const onHand = await serialsCurrentlyOnPurchase(candidates, tenantId, session);
    return candidates.filter((s) => !onHand.has(s));
}

/**
 * All returned-to-supplier serials that are not currently on a live purchase (stock list).
 * @returns {Promise<string[]>}
 */
async function distinctBlockingReturnedToSupplierSerials(tenantId) {
    const [historyReturned, soldReturned] = await Promise.all([
        SerialHistory.distinct('serialNumber', { eventType: 'returned_to_supplier' }),
        SoldSerial.distinct('serialNumber', {
            status: 'returned',
            returnDestination: 'return_to_supplier',
        }),
    ]);
    const candidates = normalizeSerialList([
        ...(historyReturned || []),
        ...(soldReturned || []),
    ]);
    if (candidates.length === 0) return [];
    const onHand = await serialsCurrentlyOnPurchase(candidates, tenantId);
    return candidates.filter((s) => !onHand.has(s));
}

module.exports = {
    serialsCurrentlyOnPurchase,
    findBlockingReturnedToSupplierAmong,
    distinctBlockingReturnedToSupplierSerials,
};
