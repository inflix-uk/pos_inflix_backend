const {
    enrichSaleItemsFromPurchase,
    composeProductName,
    nameMissingModel,
} = require('../src/utils/enrichSaleItemsFromPurchase');

describe('enrichSaleItemsFromPurchase helpers', () => {
    test('composeProductName joins brand model capacity colour grade', () => {
        expect(
            composeProductName({
                brand: 'SAMSUNG',
                brandModel: 'A22 5G',
                capacity: '64GB',
                colour: 'GREY',
                grade: 'GRADE A',
            })
        ).toBe('SAMSUNG A22 5G 64GB GREY GRADE A');
    });

    test('nameMissingModel detects absent model token', () => {
        expect(nameMissingModel('SAMSUNG 64GB GREY GRADE A', 'A22 5G')).toBe(true);
        expect(nameMissingModel('SAMSUNG A22 5G 64GB GREY GRADE A', 'A22 5G')).toBe(false);
    });
});
