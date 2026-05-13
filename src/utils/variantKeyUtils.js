/**
 * Shared variant key normalization for VariantGroupPrice and POS resolution.
 * Used by: pricing group rate list (save/load), getPurchases (forSales),
 * getFindInStockSerial, getFindInStockSerialsBatch, resolveGroupPricesForPurchases.
 *
 * Rules (must match frontend ProductsRateTable variantKey()):
 * - Parts: category, grade (condition), brand, brandModel (model), capacity.
 * - Each part: null/undefined → ''; then String(part).trim(); empty strings removed.
 * - Join non-empty parts with single space; result toUpperCase().
 * - No colour; colour does not affect price.
 */

/**
 * Build canonical variant key from five parts (all optional).
 * @param {string} [category] - Category name
 * @param {string} [grade] - Grade/condition
 * @param {string} [brand] - Brand
 * @param {string} [brandModel] - Model (brandModel)
 * @param {string} [capacity] - Capacity
 * @returns {string} Normalized key, e.g. "PHONES A SAMSUNG S23 ULTRA 256GB", or '' if all parts empty
 */
function buildVariantKey(category, grade, brand, brandModel, capacity) {
    const parts = [category, grade, brand, brandModel, capacity]
        .map((s) => (s == null || s === undefined ? '' : String(s).trim()))
        .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join(' ').toUpperCase() : '';
}

/**
 * Normalize a variant key string (e.g. from API body) to canonical form.
 * Trims, collapses whitespace, uppercases. Use when persisting variantKey from client.
 * @param {string} [input]
 * @returns {string}
 */
function normalizeVariantKey(input) {
    if (input == null || input === undefined) return '';
    const trimmed = String(input).trim();
    if (!trimmed) return '';
    const parts = trimmed.split(/\s+/).filter(Boolean);
    return parts.length > 0 ? parts.join(' ').toUpperCase() : '';
}

module.exports = {
    buildVariantKey,
    normalizeVariantKey
};
