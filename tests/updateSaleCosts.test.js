/**
 * Editing an invoice keeps each line's cost-at-sale. Lines are matched to their pre-edit
 * version by SKU: removing the top line must not hand every later line its neighbour's cost
 * (INV-000205: a removed iPhone's £640 cost landed on a Redmi and the day showed a loss).
 * No DB: models and services are mocked.
 */

jest.mock('../src/services/salesTransactionService', () => ({
    resolveCostsForSaleItems: jest.fn(async (items) => items.map(() => ({
        unit_cost_at_sale: 999, cost_missing: false, purchaseId: 'resolved', purchaseItemId: 'resolved',
    }))),
}));
jest.mock('../src/utils/returnedToSupplierQueries', () => ({ findBlockingReturnedToSupplierAmong: jest.fn(async () => []) }));
jest.mock('../src/utils/activeSoldSerialQueries', () => ({ findActiveSoldSerialsAmong: jest.fn(async () => []) }));
jest.mock('../src/services/auditService', () => ({ logFromReq: jest.fn(async () => {}) }));
jest.mock('../src/services/activityLogService', () => ({ logFromReq: jest.fn(async () => {}) }));
jest.mock('../src/services/metricsService', () => ({ saleTotalEditDelta: jest.fn(async () => {}) }));
jest.mock('../src/lib/cache', () => {
    const actual = jest.requireActual('../src/lib/cache');
    return { ...actual, bumpMany: jest.fn(async () => {}), bumpNs: jest.fn(async () => {}) };
});

const Sale = require('../src/models/Sale');
const Product = require('../src/models/Product');
const { updateSale } = require('../src/controllers/salesController');

const line = (sku, name, price, cost, purchaseId) => ({
    sku, name, price, quantity: 1, unit: 'piece', serialNumbers: [],
    unit_cost_at_sale: cost, cost_missing: false, purchaseId, purchaseItemId: `${purchaseId}-item`,
});

function saleDoc(items) {
    const doc = {
        _id: '65f0a1b2c3d4e5f6a7b8c9d0', tenantId: 'fonewarehouse', type: 'retail', status: 'active',
        reference: 'INV-000205', customerId: null, locationId: null,
        items, subtotal: 0, tax: 0, total: items.reduce((s, i) => s + i.price, 0), discount: 0,
        payments: { cash: 0, card: 0, bank: 0, credit: 0 },
        save: jest.fn(async () => doc),
        toObject() { const { save, toObject, ...rest } = doc; return JSON.parse(JSON.stringify(rest)); },
    };
    return doc;
}

async function edit(doc, newItems) {
    Sale.findOne = jest.fn(async () => doc);
    const req = {
        params: { id: doc._id },
        tenantId: 'fonewarehouse',
        user: { _id: 'u1', id: 'u1', role: 'cashier' },
        body: {
            items: newItems.map(({ sku, name, price, quantity, serialNumbers }) => ({ sku, name, price, quantity, serialNumbers })),
            total: newItems.reduce((s, i) => s + i.price * i.quantity, 0),
        },
    };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await updateSale(req, res, (err) => { if (err) throw err; });
    return res;
}

beforeEach(() => {
    Product.findOneAndUpdate = jest.fn(async () => null);
    Product.findOne = jest.fn(async () => null);
});
afterEach(() => {
    delete Sale.findOne;
    delete Product.findOneAndUpdate;
    delete Product.findOne;
});

test('removing the top line leaves every other line with its own cost and purchase', async () => {
    const iphone = line('P1-I1', 'APPLE IPHONE 17 256GB GREEN', 660, 640, 'P1');
    const redmi = line('P2-I2', 'REDMI A7 PRO 64GB GREEN', 80, 73, 'P2');
    const a27 = line('P3-I3', 'A27 128GB LIGHT GREEN', 175, 163, 'P3');
    const doc = saleDoc([iphone, redmi, a27]);

    const res = await edit(doc, [redmi, a27]);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.items.map((i) => [i.name, i.unit_cost_at_sale, i.purchaseId])).toEqual([
        ['REDMI A7 PRO 64GB GREEN', 73, 'P2'],
        ['A27 128GB LIGHT GREEN', 163, 'P3'],
    ]);
});

test('reordered lines keep their own costs; a repeated SKU keeps both costs in order', async () => {
    const a = line('P1-I1', 'A', 100, 50, 'P1');
    const b1 = line('P2-I2', 'B', 100, 60, 'P2');
    const b2 = { ...line('P2-I2', 'B', 100, 61, 'P2') };
    const doc = saleDoc([a, b1, b2]);

    await edit(doc, [b1, a, b2]);

    expect(doc.items.map((i) => [i.name, i.unit_cost_at_sale])).toEqual([['B', 60], ['A', 50], ['B', 61]]);
});

test('a line added in the edit gets a freshly resolved cost', async () => {
    const a = line('P1-I1', 'A', 100, 50, 'P1');
    const doc = saleDoc([a]);
    const added = line('P9-I9', 'NEW', 120, 0, 'P9');

    await edit(doc, [added, a]);

    expect(doc.items.map((i) => [i.name, i.unit_cost_at_sale, i.purchaseId])).toEqual([
        ['NEW', 999, 'resolved'],
        ['A', 50, 'P1'],
    ]);
});
