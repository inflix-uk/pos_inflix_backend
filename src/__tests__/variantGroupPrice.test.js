/**
 * VariantGroupPrice: precedence chain and clear/fallback behavior.
 * Precedence: (1) VariantGroupPrice (2) ProductGroupPrice / product default (3) item/default sale price.
 * Clear: blank/null price removes VariantGroupPrice record; resolution falls back to (2) then (3).
 */

const { buildVariantKey } = require('../utils/variantKeyUtils');

// In-memory simulation of resolution order (matches purchaseController logic)
function resolvePriceForItem(opts) {
    const { variantKey, variantGroupPrice, productGroupPriceOrDefault, itemSalePrice } = opts;
    if (variantKey && variantGroupPrice != null && typeof variantGroupPrice === 'number' && !Number.isNaN(variantGroupPrice) && variantGroupPrice >= 0) {
        return variantGroupPrice;
    }
    if (productGroupPriceOrDefault != null && typeof productGroupPriceOrDefault === 'number' && !Number.isNaN(productGroupPriceOrDefault) && productGroupPriceOrDefault >= 0) {
        return productGroupPriceOrDefault;
    }
    const item = typeof itemSalePrice === 'number' && !Number.isNaN(itemSalePrice) && itemSalePrice >= 0 ? itemSalePrice : 0;
    return item;
}

describe('VariantGroupPrice precedence', () => {
    test('VariantGroupPrice first when present', () => {
        expect(resolvePriceForItem({
            variantKey: 'PHONES A SAMSUNG 256GB',
            variantGroupPrice: 90,
            productGroupPriceOrDefault: 100,
            itemSalePrice: 95
        })).toBe(90);
    });

    test('ProductGroupPrice/default when no variant price', () => {
        expect(resolvePriceForItem({
            variantKey: 'PHONES A SAMSUNG 256GB',
            variantGroupPrice: null,
            productGroupPriceOrDefault: 100,
            itemSalePrice: 95
        })).toBe(100);
    });

    test('item sale price when no variant or product group price', () => {
        expect(resolvePriceForItem({
            variantKey: 'PHONES A SAMSUNG 256GB',
            variantGroupPrice: null,
            productGroupPriceOrDefault: null,
            itemSalePrice: 95
        })).toBe(95);
    });

    test('clear variant price (null) falls back to product then item', () => {
        expect(resolvePriceForItem({
            variantKey: 'PHONES A SAMSUNG 256GB',
            variantGroupPrice: null,
            productGroupPriceOrDefault: 100,
            itemSalePrice: 80
        })).toBe(100);
        expect(resolvePriceForItem({
            variantKey: 'PHONES A SAMSUNG 256GB',
            variantGroupPrice: null,
            productGroupPriceOrDefault: null,
            itemSalePrice: 80
        })).toBe(80);
    });

    test('empty variantKey no variant lookup', () => {
        expect(resolvePriceForItem({
            variantKey: '',
            variantGroupPrice: 90,
            productGroupPriceOrDefault: 100,
            itemSalePrice: 95
        })).toBe(100);
    });
});

describe('VariantGroupPrice + buildVariantKey consistency', () => {
    test('same inputs produce same key across flows', () => {
        const key1 = buildVariantKey('Phones', 'A', 'Samsung', 'S23 Ultra', '256GB');
        const key2 = buildVariantKey('  Phones  ', ' A ', 'Samsung', 'S23 Ultra', '256GB');
        expect(key1).toBe(key2);
        expect(key1).toBe('PHONES A SAMSUNG S23 ULTRA 256GB');
    });
});
