const {
    preservePurchaseItemBrandModels,
    pickModel,
} = require('../src/utils/preservePurchaseItemBrandModels');

describe('preservePurchaseItemBrandModels', () => {
    test('keeps existing brandModel when incoming is blank (IMEI overlap)', () => {
        const existing = [
            {
                brand: 'APPLE',
                brandModel: 'IPHONE 12',
                capacity: '64GB',
                imeis: ['351111111111111', '352222222222222'],
                variantValues: [{ slug: 'brand_model', value: 'IPHONE 12' }],
            },
        ];
        const incoming = [
            {
                brand: 'APPLE',
                brandModel: '',
                capacity: '64GB',
                imeis: ['351111111111111', '352222222222222'],
                variantValues: [{ slug: 'brands', value: 'APPLE' }],
            },
        ];
        const { items, preserved } = preservePurchaseItemBrandModels(incoming, existing);
        expect(preserved).toBe(1);
        expect(pickModel(items[0])).toBe('IPHONE 12');
        expect(items[0].brandModel).toBe('IPHONE 12');
        expect(items[0].variantValues.some((v) => v.slug === 'brand_model' && v.value === 'IPHONE 12')).toBe(true);
    });

    test('does not overwrite an incoming brandModel', () => {
        const existing = [{ brandModel: 'OLD', imeis: ['351111111111111'] }];
        const incoming = [{ brandModel: 'NEW MODEL', imeis: ['351111111111111'] }];
        const { items, preserved } = preservePurchaseItemBrandModels(incoming, existing);
        expect(preserved).toBe(0);
        expect(items[0].brandModel).toBe('NEW MODEL');
    });

    test('leaves blank when no prior model exists', () => {
        const existing = [{ brandModel: '', imeis: ['351111111111111'] }];
        const incoming = [{ brandModel: '', imeis: ['351111111111111'] }];
        const { items, preserved } = preservePurchaseItemBrandModels(incoming, existing);
        expect(preserved).toBe(0);
        expect(pickModel(items[0])).toBe('');
    });
});
