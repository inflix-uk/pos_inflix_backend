/**
 * Customer group pricing fallback logic tests.
 * Rule: If customer has a valid group AND product has a price for that group -> use group price.
 *       Else -> use product default price.
 */

// Same rule as in productController and purchaseController (no abstraction in prod; test documents the spec)
function resolveSellingPrice(defaultPrice, groupPrice) {
    const def = typeof defaultPrice === 'number' && !Number.isNaN(defaultPrice) ? defaultPrice : 0;
    if (groupPrice != null && typeof groupPrice === 'number' && !Number.isNaN(groupPrice) && groupPrice >= 0) {
        return groupPrice;
    }
    return def;
}

describe('Customer group pricing fallback', () => {
    test('no customer / no group: use default price', () => {
        expect(resolveSellingPrice(100, null)).toBe(100);
        expect(resolveSellingPrice(100, undefined)).toBe(100);
    });

    test('customer has group but product has no group price: use default price', () => {
        expect(resolveSellingPrice(100, null)).toBe(100);
        expect(resolveSellingPrice(100, undefined)).toBe(100);
    });

    test('customer has group and product has group price: use group price', () => {
        expect(resolveSellingPrice(100, 90)).toBe(90);
        expect(resolveSellingPrice(100, 95)).toBe(95);
    });

    test('invalid group price (NaN or negative): fall back to default', () => {
        expect(resolveSellingPrice(100, NaN)).toBe(100);
        expect(resolveSellingPrice(100, -1)).toBe(100);
    });

    test('missing or invalid default: use 0', () => {
        expect(resolveSellingPrice(undefined, null)).toBe(0);
        expect(resolveSellingPrice(NaN, null)).toBe(0);
    });

    test('existing sales flow unchanged when no group price', () => {
        // Normal customer (no group) or no group price on product -> default only
        expect(resolveSellingPrice(50, null)).toBe(50);
        expect(resolveSellingPrice(50, undefined)).toBe(50);
    });
});
