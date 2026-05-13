/**
 * Shared variant key normalization. Must match frontend ProductsRateTable variantKey().
 * Used by: pricing group rate list save/load, getPurchases (forSales), getFindInStockSerial,
 * getFindInStockSerialsBatch, resolveGroupPricesForPurchases.
 */

const { buildVariantKey, normalizeVariantKey } = require('../utils/variantKeyUtils');

describe('buildVariantKey', () => {
    test('joins non-empty parts with space and uppercases', () => {
        expect(buildVariantKey('Phones', 'A', 'Samsung', 'S23 Ultra', '256GB')).toBe('PHONES A SAMSUNG S23 ULTRA 256GB');
    });

    test('trims each part and filters empty', () => {
        expect(buildVariantKey('  Phones  ', ' A ', ' Samsung ', '', '256GB')).toBe('PHONES A SAMSUNG 256GB');
    });

    test('null/undefined parts treated as empty and filtered', () => {
        expect(buildVariantKey('Phones', null, 'Samsung', undefined, '256GB')).toBe('PHONES SAMSUNG 256GB');
    });

    test('all empty returns empty string', () => {
        expect(buildVariantKey('', '', '', '', '')).toBe('');
        expect(buildVariantKey(null, undefined, '', null, undefined)).toBe('');
    });

    test('single part', () => {
        expect(buildVariantKey('Phones', '', '', '', '')).toBe('PHONES');
    });

    test('grade/condition and brandModel normalized like category/brand/capacity', () => {
        expect(buildVariantKey('Phones', 'Grade A', 'Apple', 'iPhone 15 Pro', '128GB')).toBe('PHONES GRADE A APPLE IPHONE 15 PRO 128GB');
    });
});

describe('normalizeVariantKey', () => {
    test('trims and uppercases', () => {
        expect(normalizeVariantKey('  phones a samsung  ')).toBe('PHONES A SAMSUNG');
    });

    test('collapses multiple spaces', () => {
        expect(normalizeVariantKey('Phones   A   Samsung')).toBe('PHONES A SAMSUNG');
    });

    test('null/undefined returns empty string', () => {
        expect(normalizeVariantKey(null)).toBe('');
        expect(normalizeVariantKey(undefined)).toBe('');
    });

    test('empty string returns empty', () => {
        expect(normalizeVariantKey('')).toBe('');
        expect(normalizeVariantKey('   ')).toBe('');
    });

    test('same output as buildVariantKey for equivalent input', () => {
        const key = buildVariantKey('Phones', 'A', 'Samsung', 'S23 Ultra', '256GB');
        expect(normalizeVariantKey('Phones A Samsung S23 Ultra 256GB')).toBe(key);
    });
});
