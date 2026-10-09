/**
 * Adding or removing a serialised unit by editing an invoice keeps stock in step: the unit is
 * recorded as sold on that invoice (even if it was sold and returned before — one SoldSerial
 * row per serial) and the StockItem index behind Serial Products / the sale search follows.
 * Before, re-adding a returned unit crashed after the invoice was saved, so it stayed "in stock"
 * and could be sold twice. No DB: models and services are mocked.
 */

jest.mock('../src/services/salesTransactionService', () => ({
    resolveCostsForSaleItems: jest.fn(async (items) => items.map(() => ({ unit_cost_at_sale: 100, cost_missing: false }))),
}));
jest.mock('../src/utils/returnedToSupplierQueries', () => ({ findBlockingReturnedToSupplierAmong: jest.fn(async () => []) }));
jest.mock('../src/utils/activeSoldSerialQueries', () => ({ findActiveSoldSerialsAmong: jest.fn(async () => []) }));
jest.mock('../src/services/auditService', () => ({ logFromReq: jest.fn(async () => {}) }));
jest.mock('../src/services/activityLogService', () => ({ logFromReq: jest.fn(async () => {}) }));
jest.mock('../src/services/metricsService', () => ({ saleTotalEditDelta: jest.fn(async () => {}) }));
jest.mock('../src/services/serialIndexService', () => ({
    normalizeSerial: (s) => String(s || '').trim(),
    upsertSerialIndex: jest.fn(async () => {}),
    upsertFromResult: jest.fn(async () => {}),
    invalidateSerial: jest.fn(async () => {}),
}));
// The serial index refresh looks the unit up in purchases; no DB here.
jest.mock('../src/controllers/purchaseController', () => ({
    ...jest.requireActual('../src/controllers/purchaseController'),
    legacyFindInStockSerials: jest.fn(async () => []),
}));
jest.mock('../src/services/stockItemService', () => ({
    markSold: jest.fn(async () => {}),
    markInStock: jest.fn(async () => {}),
}));
jest.mock('../src/lib/cache', () => {
    const actual = jest.requireActual('../src/lib/cache');
    return { ...actual, bumpMany: jest.fn(async () => {}), bumpNs: jest.fn(async () => {}) };
});

const Sale = require('../src/models/Sale');
const Product = require('../src/models/Product');
const SoldSerial = require('../src/models/SoldSerial');
const SerialHistory = require('../src/models/SerialHistory');
const stockItemService = require('../src/services/stockItemService');
const { findActiveSoldSerialsAmong } = require('../src/utils/activeSoldSerialQueries');
const { updateSale } = require('../src/controllers/salesController');

const SALE_ID = '65f0a1b2c3d4e5f6a7b8c9d0';
const line = (sku, name, serials) => ({
    sku, name, price: 200, quantity: serials.length, unit: 'piece', serialNumbers: serials,
    unit_cost_at_sale: 150, cost_missing: false, purchaseId: 'P1', purchaseItemId: 'I1',
});

function saleDoc(items) {
    const doc = {
        _id: SALE_ID, tenantId: 'tbm', type: 'retail', status: 'active', reference: 'INV-001998',
        customerId: null, customerName: 'BRIT MOBILES', locationId: null,
        items, subtotal: 0, tax: 0, total: 0, discount: 0, payments: {},
        save: jest.fn(async () => doc),
        toObject() { const { save, toObject, ...rest } = doc; return JSON.parse(JSON.stringify(rest)); },
    };
    return doc;
}

async function edit(doc, newItems) {
    Sale.findOne = jest.fn(async () => doc);
    const req = {
        params: { id: SALE_ID }, tenantId: 'tbm', user: { _id: 'u1', role: 'cashier' },
        body: { items: newItems.map(({ sku, name, price, quantity, serialNumbers }) => ({ sku, name, price, quantity, serialNumbers })) },
    };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await updateSale(req, res, (err) => { if (err) throw err; });
    return res;
}

let soldUpsert;
let soldDelete;
beforeEach(() => {
    jest.clearAllMocks();
    findActiveSoldSerialsAmong.mockResolvedValue([]);
    soldUpsert = jest.fn(async () => ({}));
    soldDelete = jest.fn(async () => ({}));
    SoldSerial.findOneAndUpdate = soldUpsert;
    SoldSerial.deleteMany = soldDelete;
    SoldSerial.findOne = jest.fn(() => ({ lean: async () => null }));
    SerialHistory.create = jest.fn(async () => ({}));
    SerialHistory.insertMany = jest.fn(async () => []);
    Product.findOne = jest.fn(async () => null);
    Product.findOneAndUpdate = jest.fn(async () => null);
});
afterEach(() => {
    for (const [model, fns] of [[Sale, ['findOne']], [SoldSerial, ['findOneAndUpdate', 'deleteMany', 'findOne']], [SerialHistory, ['create', 'insertMany']], [Product, ['findOne', 'findOneAndUpdate']]]) {
        for (const fn of fns) delete model[fn];
    }
});

test('a unit added by an edit is recorded as sold on this invoice, taking over an earlier returned record', async () => {
    const doc = saleDoc([line('P1-I1', 'IPHONE 13', ['111'])]);

    const res = await edit(doc, [line('P1-I1', 'IPHONE 13', ['111', '354228670104909'])]);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(soldUpsert).toHaveBeenCalledTimes(1);
    const [filter, update, options] = soldUpsert.mock.calls[0];
    expect(filter).toEqual({ serialNumber: '354228670104909' });
    expect(update.$set).toMatchObject({ saleId: SALE_ID, status: 'sold', returnDestination: null, returnedAt: null, salesReturnId: null });
    expect(options).toMatchObject({ upsert: true });
    expect(stockItemService.markSold).toHaveBeenCalledWith(['354228670104909'], expect.objectContaining({ tenantId: 'tbm', saleId: SALE_ID, saleReference: 'INV-001998' }));
});

test('every unit added in the same edit is recorded, not only the first', async () => {
    const doc = saleDoc([line('P1-I1', 'IPHONE 14', ['111'])]);

    await edit(doc, [line('P1-I1', 'IPHONE 14', ['111', '222', '333', '444'])]);

    expect(soldUpsert.mock.calls.map((c) => c[0].serialNumber)).toEqual(['222', '333', '444']);
    expect(stockItemService.markSold.mock.calls[0][0]).toEqual(['222', '333', '444']);
});

test('a unit removed by an edit goes back to stock everywhere', async () => {
    const doc = saleDoc([line('P1-I1', 'IPHONE 14', ['111', '222'])]);

    await edit(doc, [line('P1-I1', 'IPHONE 14', ['111'])]);

    expect(soldDelete).toHaveBeenCalledWith({ saleId: SALE_ID, serialNumber: { $in: ['222'] } });
    expect(stockItemService.markInStock).toHaveBeenCalledWith(['222'], 'tbm');
    expect(soldUpsert).not.toHaveBeenCalled();
});

test('a unit still sold on another active invoice is refused', async () => {
    findActiveSoldSerialsAmong.mockResolvedValue([{ serialNumber: '999', saleId: 'another-sale' }]);
    const doc = saleDoc([line('P1-I1', 'IPHONE 14', ['111'])]);

    const res = await edit(doc, [line('P1-I1', 'IPHONE 14', ['111', '999'])]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(soldUpsert).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
});
