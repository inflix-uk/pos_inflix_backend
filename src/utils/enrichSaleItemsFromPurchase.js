const Purchase = require('../models/Purchase');
const { formatProductName } = require('./formatProductName');

function imeiKey(s) {
    return String(s || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function composeProductName(fields) {
    const parts = [fields.brand, fields.brandModel, fields.capacity, fields.colour, fields.grade]
        .map((x) => (x != null ? String(x).trim() : ''))
        .filter(Boolean);
    return formatProductName(parts.join(' ')) || '';
}

function nameMissingModel(name, brandModel) {
    const model = String(brandModel || '').trim();
    if (!model) return false;
    const nm = String(name || '').toUpperCase();
    const m = model.toUpperCase();
    return !nm.includes(m);
}

/**
 * Enrich sale line items from the purchase/parcel that owns the IMEIs.
 * Fixes cart names that were baked without brandModel (stale SerialIndex / wiped purchase).
 */
async function enrichSaleItemsFromPurchase(items, tenantId) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const allSerials = [
        ...new Set(
            items.flatMap((i) => (Array.isArray(i.serialNumbers) ? i.serialNumbers : []))
                .map((s) => String(s || '').trim())
                .filter(Boolean)
        ),
    ];
    if (allSerials.length === 0) return items;

    const keySet = new Set(allSerials.map(imeiKey).filter(Boolean));
    const purchases = await Purchase.find({
        tenantId: tenantId || 'default',
        'items.imeis': { $in: allSerials },
    })
        .select('items.imeis items.brand items.brandModel items.capacity items.colour items.grade items.name')
        .lean();

    const bySerial = new Map();
    for (const p of purchases || []) {
        for (const it of p.items || []) {
            for (const imei of it.imeis || []) {
                const k = imeiKey(imei);
                if (!k || !keySet.has(k) || bySerial.has(k)) continue;
                bySerial.set(k, it);
            }
        }
    }
    if (bySerial.size === 0) return items;

    return items.map((item) => {
        const serials = Array.isArray(item.serialNumbers) ? item.serialNumbers : [];
        let inv = null;
        for (const s of serials) {
            inv = bySerial.get(imeiKey(s));
            if (inv) break;
        }
        if (!inv) return item;

        const brand = (item.brand && String(item.brand).trim()) || (inv.brand && String(inv.brand).trim()) || '';
        const brandModel =
            (item.brandModel && String(item.brandModel).trim()) ||
            (inv.brandModel && String(inv.brandModel).trim()) ||
            '';
        const capacity =
            (item.capacity && String(item.capacity).trim()) ||
            (inv.capacity && String(inv.capacity).trim()) ||
            '';
        const colour =
            (item.colour && String(item.colour).trim()) ||
            (inv.colour && String(inv.colour).trim()) ||
            '';
        const grade =
            (item.grade && String(item.grade).trim()) ||
            (inv.grade && String(inv.grade).trim()) ||
            '';

        const composed = composeProductName({ brand, brandModel, capacity, colour, grade });
        const currentName = item.name != null ? String(item.name).trim() : '';
        const shouldReplaceName =
            !currentName ||
            nameMissingModel(currentName, brandModel) ||
            (brandModel && /^product$/i.test(currentName));

        return {
            ...item,
            brand,
            brandModel,
            capacity,
            colour,
            grade,
            name: shouldReplaceName && composed ? composed : currentName || composed || item.name,
        };
    });
}

module.exports = {
    enrichSaleItemsFromPurchase,
    composeProductName,
    nameMissingModel,
    imeiKey,
};
