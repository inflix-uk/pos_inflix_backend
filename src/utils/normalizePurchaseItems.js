const { formatProductName } = require('./formatProductName');

const VARIANT_SLUG_ORDER = ['brands', 'brand', 'brands_model', 'brand_model', 'make', 'grade', 'storage', 'capacity', 'color', 'colour', 'condition'];

function variantSlugRank(slug) {
    const i = VARIANT_SLUG_ORDER.indexOf((slug || '').toLowerCase());
    return i === -1 ? VARIANT_SLUG_ORDER.length : i;
}

function toUpper(value) {
    return formatProductName(value);
}

/** Uppercase text fields on purchase line items before save. */
function normalizePurchaseItems(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    return items.map((item) => {
        const normalized = { ...item };
        if (normalized.name != null) normalized.name = toUpper(normalized.name);
        if (normalized.grade != null) normalized.grade = toUpper(normalized.grade);
        if (normalized.brand != null) normalized.brand = toUpper(normalized.brand);
        if (normalized.brandModel != null) normalized.brandModel = toUpper(normalized.brandModel);
        if (normalized.capacity != null) normalized.capacity = toUpper(normalized.capacity);
        if (normalized.colour != null) normalized.colour = toUpper(normalized.colour);
        if (normalized.variantValues != null) {
            if (Array.isArray(normalized.variantValues)) {
                normalized.variantValues = normalized.variantValues
                    .map((entry) => ({
                        slug: entry.slug || '',
                        value: toUpper(entry.value) || ''
                    }))
                    .filter((e) => e.slug)
                    .sort((a, b) => variantSlugRank(a.slug) - variantSlugRank(b.slug));
            } else if (typeof normalized.variantValues === 'object') {
                normalized.variantValues = Object.entries(normalized.variantValues)
                    .map(([slug, value]) => ({
                        slug,
                        value: toUpper(value) || ''
                    }))
                    .filter((e) => e.value !== undefined && e.value !== null)
                    .sort((a, b) => variantSlugRank(a.slug) - variantSlugRank(b.slug));
            }
        } else {
            normalized.variantValues = [];
        }
        return normalized;
    });
}

module.exports = { normalizePurchaseItems, formatProductName };
