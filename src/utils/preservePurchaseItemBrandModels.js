/**
 * Prevent accidental wipe of brandModel on purchase update.
 * Edit UI historically sent empty brandModel when the field held a name (not an option _id).
 * Match by IMEI overlap (item _ids are often regenerated on full replace) and copy the
 * previous brandModel + brand_model variant entry when the incoming value is blank.
 */

function imeiKey(imei) {
    return String(imei || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function imeiSet(item) {
    return new Set((Array.isArray(item?.imeis) ? item.imeis : []).map(imeiKey).filter(Boolean));
}

function overlapCount(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
}

function pickModel(item) {
    const direct = item?.brandModel != null ? String(item.brandModel).trim() : '';
    if (direct) return direct;
    const vv = Array.isArray(item?.variantValues) ? item.variantValues : [];
    const entry = vv.find((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return (
            (s.includes('brand_model') ||
                s.includes('brands_model') ||
                s.includes('brandmodel') ||
                s === 'model' ||
                s === 'models') &&
            v?.value
        );
    });
    return entry?.value != null ? String(entry.value).trim() : '';
}

function upsertBrandModelVariant(variantValues, model) {
    const arr = Array.isArray(variantValues) ? variantValues.map((v) => ({ ...v })) : [];
    const idx = arr.findIndex((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return s.includes('brand_model') || s.includes('brands_model') || s.includes('brandmodel') || s === 'model';
    });
    const value = String(model).trim().toUpperCase();
    if (idx >= 0) arr[idx] = { ...arr[idx], slug: arr[idx].slug || 'brand_model', value };
    else arr.push({ slug: 'brand_model', value });
    return arr;
}

/**
 * @param {object[]} incomingItems - items from the PUT body (after normalize)
 * @param {object[]} existingItems - items currently stored on the purchase
 * @returns {{ items: object[], preserved: number }}
 */
function preservePurchaseItemBrandModels(incomingItems, existingItems) {
    if (!Array.isArray(incomingItems) || incomingItems.length === 0) {
        return { items: incomingItems, preserved: 0 };
    }
    const existing = Array.isArray(existingItems) ? existingItems : [];
    let preserved = 0;

    const items = incomingItems.map((raw) => {
        const it = { ...raw };
        if (pickModel(it)) return it;

        const liveSet = imeiSet(it);
        if (liveSet.size === 0) return it;

        let best = null;
        for (const prev of existing) {
            const model = pickModel(prev);
            if (!model) continue;
            const prevSet = imeiSet(prev);
            const overlap = overlapCount(liveSet, prevSet);
            if (overlap === 0) continue;
            const score = overlap * 1000 + (prevSet.size === liveSet.size ? 100 : 0);
            if (!best || score > best.score) best = { score, model };
        }
        if (!best?.model) return it;

        const model = String(best.model).trim().toUpperCase();
        it.brandModel = model;
        it.variantValues = upsertBrandModelVariant(it.variantValues, model);
        preserved += 1;
        return it;
    });

    return { items, preserved };
}

module.exports = {
    preservePurchaseItemBrandModels,
    pickModel,
    imeiKey,
};
