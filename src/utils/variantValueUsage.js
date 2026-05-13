const Purchase = require('../models/Purchase');

/**
 * Slug to legacy field name on purchase items (for syncing variantValues with legacy fields).
 */
const SLUG_TO_LEGACY = {
    grade: 'grade',
    brands: 'brand',
    brand: 'brand',
    brand_model: 'brandModel',
    model: 'brandModel',
    storage: 'capacity',
    capacity: 'capacity',
    color: 'colour',
    colour: 'colour'
};

/**
 * Check if a variant value (attribute slug + value) is used in any purchase item.
 * Checks both items.variantValues and legacy fields (grade, brand, brandModel, capacity, colour)
 * so that older items without variantValues are still considered "in use".
 * @param {string} attributeSlug - e.g. 'storage', 'capacity', 'brands', 'grade'
 * @param {string} value - the value to look for (e.g. '125', '128GB') - matched case-insensitively
 * @returns {Promise<{ inUse: boolean, count?: number }>}
 */
async function checkVariantValueInUse(attributeSlug, value) {
    if (value == null || value === '') {
        return { inUse: false, count: 0 };
    }
    const valueStr = String(value).trim();
    if (!valueStr) return { inUse: false, count: 0 };

    const slugRaw = (attributeSlug || '').trim();
    const slugLower = slugRaw.toLowerCase();
    const legacyField = SLUG_TO_LEGACY[slugLower] || SLUG_TO_LEGACY[slugRaw];
    // Allow optional surrounding whitespace when matching value (DB may store with spaces)
    const valueRegex = new RegExp('^\\s*' + escapeRegex(valueStr) + '\\s*$', 'i');
    const slugRegex = new RegExp('^\\s*' + escapeRegex(slugRaw) + '\\s*$', 'i');

    // Count items that have this value in variantValues (run even if slug empty, slugRegex will not match then)
    const fromVariantValues = await Purchase.countDocuments({
        'items.variantValues': {
            $elemMatch: {
                slug: { $regex: slugRegex },
                value: { $regex: valueRegex }
            }
        }
    });

    if (fromVariantValues > 0) {
        return { inUse: true, count: fromVariantValues };
    }

    // Also check legacy fields (items may have been saved before variantValues or only have legacy fields)
    if (legacyField) {
        const legacyQuery = {};
        legacyQuery['items.' + legacyField] = { $regex: valueRegex };
        const fromLegacy = await Purchase.countDocuments(legacyQuery);
        if (fromLegacy > 0) {
            return { inUse: true, count: fromLegacy };
        }
    }

    // Fallback: count by value only (any slug) so we catch items where slug might differ (e.g. condition, typo)
    const fromValueOnly = await Purchase.countDocuments({
        'items.variantValues': {
            $elemMatch: { value: { $regex: valueRegex } }
        }
    });
    if (fromValueOnly > 0) {
        return { inUse: true, count: fromValueOnly };
    }

    return { inUse: false, count: 0 };
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace a variant value with another in all purchase items. Updates both variantValues array and legacy fields.
 * Handles items that have the value in variantValues and items that have it only in legacy fields.
 * Does not modify sales.
 * @param {string} attributeSlug - e.g. 'storage', 'capacity', 'brands'
 * @param {string} oldValue - current value (case-insensitive match)
 * @param {string} newValue - replacement value (will be stored as provided; API often uses UPPERCASE)
 */
async function replaceVariantValueInPurchases(attributeSlug, oldValue, newValue) {
    if (!attributeSlug || oldValue == null || newValue == null) return;
    const oldStr = String(oldValue).trim();
    const newStr = String(newValue).trim();
    if (!oldStr || !newStr) return;

    const slugLower = attributeSlug.toLowerCase();
    const legacyField = SLUG_TO_LEGACY[slugLower] || SLUG_TO_LEGACY[attributeSlug];
    const slugRegex = new RegExp('^' + escapeRegex(attributeSlug) + '$', 'i');
    const oldValueRegex = new RegExp('^' + escapeRegex(oldStr) + '$', 'i');

    // Find purchases that have this value in variantValues
    const purchasesWithVv = await Purchase.find({
        'items.variantValues': {
            $elemMatch: {
                slug: { $regex: slugRegex },
                value: { $regex: oldValueRegex }
            }
        }
    });

    for (const purchase of purchasesWithVv) {
        let modified = false;
        for (const item of purchase.items || []) {
            const vv = item.variantValues || [];
            let itemHadReplacement = false;
            for (let i = 0; i < vv.length; i++) {
                const entry = vv[i];
                const entrySlug = (entry.slug || '').toLowerCase();
                const entryValue = (entry.value || '').trim();
                const slugMatch = entrySlug === slugLower || (entry.slug && slugRegex.test(entry.slug));
                const valueMatch = entryValue.toLowerCase() === oldStr.toLowerCase();
                if (slugMatch && valueMatch) {
                    item.variantValues[i].value = newStr;
                    itemHadReplacement = true;
                    modified = true;
                }
            }
            if (legacyField && itemHadReplacement) {
                const currentLegacy = item[legacyField];
                if (currentLegacy != null && String(currentLegacy).trim().toLowerCase() === oldStr.toLowerCase()) {
                    item[legacyField] = newStr;
                }
            }
        }
        if (modified) {
            purchase.markModified('items');
            await purchase.save();
        }
    }

    // Also update items that have the value only in legacy field (no or empty variantValues)
    if (legacyField) {
        const purchasesLegacy = await Purchase.find({
            ['items.' + legacyField]: { $regex: oldValueRegex }
        });
        for (const purchase of purchasesLegacy) {
            let modified = false;
            for (const item of purchase.items || []) {
                const currentLegacy = item[legacyField];
                if (currentLegacy != null && String(currentLegacy).trim().toLowerCase() === oldStr.toLowerCase()) {
                    item[legacyField] = newStr;
                    modified = true;
                    // Optionally ensure variantValues has an entry for this slug so future checks see it
                    const vv = item.variantValues || [];
                    const existing = vv.find((e) => e.slug && slugRegex.test(e.slug));
                    if (!existing) {
                        vv.push({ slug: attributeSlug, value: newStr });
                        item.variantValues = vv;
                    }
                }
            }
            if (modified) {
                purchase.markModified('items');
                await purchase.save();
            }
        }
    }
}

module.exports = {
    checkVariantValueInUse,
    replaceVariantValueInPurchases,
    SLUG_TO_LEGACY
};
