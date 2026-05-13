/**
 * SoldSerial rows can outlive inconsistent state; inventory and POS must treat a serial as
 * "sold" only when the linked Sale exists and is not voided.
 */
const SoldSerial = require('../models/SoldSerial');
const Sale = require('../models/Sale');

function lookupActiveSaleStages() {
    const from = Sale.collection.name;
    // Use filtered $lookup (pipeline form) so MongoDB only fetches non-voided sale docs,
    // avoiding pulling full voided sale documents into memory.
    return [
        {
            $lookup: {
                from,
                let: { sid: '$saleId' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$_id', '$$sid'] }, status: { $ne: 'voided' } } },
                    { $project: { _id: 1 } }
                ],
                as: '_lkSale'
            }
        },
        { $match: { '_lkSale.0': { $exists: true } } },
    ];
}

/**
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<string[]>}
 */
async function distinctSerialNumbersSoldOnActiveSales(session = null) {
    // Fast path: get voided sale IDs first (usually a tiny set), then exclude
    // those from a simple SoldSerial.distinct() — avoids expensive $lookup per row.
    const voidedQuery = Sale.find({ status: 'voided' }).select('_id').lean();
    if (session) voidedQuery.session(session);
    const voidedSales = await voidedQuery;
    const voidedIds = (voidedSales || []).map((s) => s._id);

    const soldQuery = { status: { $ne: 'returned' } };
    if (voidedIds.length > 0) {
        soldQuery.saleId = { $nin: voidedIds };
    }
    let distinctQ = SoldSerial.distinct('serialNumber', soldQuery);
    if (session) distinctQ = distinctQ.session(session);
    const serials = await distinctQ;
    return (serials || []).map((s) => String(s || '').trim()).filter(Boolean);
}

/**
 * SoldSerial docs among `serials` that block a new sale (active / non-voided invoice).
 * @param {string[]} serials
 * @param {import('mongoose').ClientSession} [session]
 */
async function findActiveSoldSerialsAmong(serials, session = null) {
    if (!serials || serials.length === 0) return [];
    const trimmed = [...new Set(serials.map((s) => String(s).trim()).filter(Boolean))];
    if (trimmed.length === 0) return [];
    const pipeline = [
        { $match: { serialNumber: { $in: trimmed }, status: { $ne: 'returned' } } },
        ...lookupActiveSaleStages(),
        { $project: { serialNumber: 1, saleId: 1 } },
    ];
    let agg = SoldSerial.aggregate(pipeline);
    if (session) agg = agg.session(session);
    return agg;
}

module.exports = {
    distinctSerialNumbersSoldOnActiveSales,
    findActiveSoldSerialsAmong,
    lookupActiveSaleStages,
};
