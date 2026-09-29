/**
 * Keep each IMEI's SID when a purchase is edited.
 * The edit page replaces the whole items array and does not send `imeiSerials`, so without this
 * every edit blanks the SID column. SIDs are matched by IMEI (item _ids are regenerated on full
 * replace). IMEIs added during the edit get new SIDs, as they would on a new purchase; IMEIs that
 * were already on the purchase without a SID stay without one.
 */

function imeiKey(imei) {
    return String(imei || '').trim();
}

/** IMEI → SID on the stored purchase (per-IMEI `imeiSerials`, else the legacy item-level SID). */
function collectExistingSids(existingItems) {
    const sidByImei = new Map();
    const knownImeis = new Set();
    for (const item of existingItems || []) {
        const imeis = Array.isArray(item?.imeis) ? item.imeis : [];
        const perImei = new Map();
        for (const entry of Array.isArray(item?.imeiSerials) ? item.imeiSerials : []) {
            if (entry && entry.imei && entry.serialItemIdNumber) perImei.set(imeiKey(entry.imei), entry.serialItemIdNumber);
        }
        for (const imei of imeis) {
            const key = imeiKey(imei);
            if (!key) continue;
            knownImeis.add(key);
            const sid = perImei.get(key) || item.serialItemIdNumber;
            if (sid && !sidByImei.has(key)) sidByImei.set(key, sid);
        }
    }
    return { sidByImei, knownImeis };
}

/** IMEIs in the incoming items that were not on the purchase before (need a new SID). */
function countNewImeis(incomingItems, existingItems) {
    const { knownImeis } = collectExistingSids(existingItems);
    let count = 0;
    for (const item of incomingItems || []) {
        if (item?.isOtherItem || !Array.isArray(item?.imeis)) continue;
        for (const imei of item.imeis) {
            const key = imeiKey(imei);
            if (key && !knownImeis.has(key)) count++;
        }
    }
    return count;
}

/**
 * @param {object[]} incomingItems - items from the PUT body (after normalize)
 * @param {object[]} existingItems - items currently stored on the purchase
 * @param {number|null} nextSeq - next SID sequence number, needed only when there are new IMEIs
 * @returns {{ items: object[], preserved: number, assigned: number }}
 */
function preservePurchaseItemSids(incomingItems, existingItems, nextSeq = null) {
    if (!Array.isArray(incomingItems) || incomingItems.length === 0) {
        return { items: incomingItems, preserved: 0, assigned: 0 };
    }
    const { sidByImei, knownImeis } = collectExistingSids(existingItems);
    let seq = nextSeq;
    let preserved = 0;
    let assigned = 0;

    const items = incomingItems.map((raw) => {
        if (!raw || raw.isOtherItem || !Array.isArray(raw.imeis) || raw.imeis.length === 0) return raw;
        const it = { ...raw };
        const serials = [];
        for (const imei of it.imeis) {
            const key = imeiKey(imei);
            let sid = sidByImei.get(key);
            if (sid) {
                preserved++;
            } else if (key && !knownImeis.has(key) && seq != null) {
                sid = `SID-${String(seq++).padStart(6, '0')}`;
                assigned++;
            }
            if (sid) serials.push({ imei: String(imei), serialItemIdNumber: sid });
        }
        it.imeiSerials = serials;
        // Per-IMEI SIDs replace the legacy item-level one (it was copied onto each of its IMEIs above).
        delete it.serialItemIdNumber;
        return it;
    });
    return { items, preserved, assigned };
}

module.exports = { preservePurchaseItemSids, countNewImeis };
