const { parsePurchaseLineSku } = require('../src/utils/printVariantAttributes');

describe('parsePurchaseLineSku', () => {
  it('parses non-serial purchase line SKU', () => {
    const purchaseId = '507f1f77bcf86cd799439011';
    const itemId = '507f1f77bcf86cd799439012';
    const sku = `${purchaseId}-${itemId}-no-imei`;
    expect(parsePurchaseLineSku(sku)).toEqual({ purchaseId, itemId });
  });

  it('parses serial purchase line SKU', () => {
    const purchaseId = '507f1f77bcf86cd799439011';
    const itemId = '507f1f77bcf86cd799439012';
    const sku = `${purchaseId}-${itemId}-356938035643809`;
    expect(parsePurchaseLineSku(sku)).toEqual({ purchaseId, itemId });
  });

  it('returns null for catalog product SKU', () => {
    expect(parsePurchaseLineSku('USB-CABLE-1M')).toBeNull();
    expect(parsePurchaseLineSku('CASE-1')).toBeNull();
  });
});
