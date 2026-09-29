/**
 * After a price edit, the serial index is refreshed from the purchase: in-stock IMEIs get the new
 * prices, while a sold, returned, moved or written-off IMEI on the same line keeps its status
 * (the sale scan trusts an in-stock index entry without re-checking sales). No DB: models are mocked.
 */

jest.mock('../src/services/serialIndexService', () => {
    const actual = jest.requireActual('../src/services/serialIndexService');
    return {
        ...actual,
        upsertFromResult: jest.fn(async () => {}),
        upsertSerialIndex: jest.fn(async () => {}),
    };
});
jest.mock('../src/utils/returnedToSupplierQueries', () => {
    const actual = jest.requireActual('../src/utils/returnedToSupplierQueries');
    return { ...actual, findBlockingReturnedToSupplierAmong: jest.fn(async () => ['S4']) };
});

const Purchase = require('../src/models/Purchase');
const SoldSerial = require('../src/models/SoldSerial');
const SerialIndex = require('../src/models/SerialIndex');
const serialIndexService = require('../src/services/serialIndexService');
const { reindexSerialsFromPurchases } = require('../src/controllers/purchaseController');

const purchaseId = '65f0a1b2c3d4e5f6a7b8c9d0';
const itemId = '65f0a1b2c3d4e5f6a7b8c9d1';
let serialIndexFind;

beforeEach(() => {
    jest.clearAllMocks();
    // Models are Proxies (lib/tenantModel): assign mocks on the underlying model, delete afterwards.
    SoldSerial.find = jest.fn(() => ({
        select: () => ({
            populate: () => ({
                lean: async () => [
                    { serialNumber: 'S2', saleId: { reference: 'INV-000141', customerName: 'Rehman', status: 'completed' } },
                ],
            }),
        }),
    }));
    Purchase.find = jest.fn(() => ({
        populate: () => ({
            lean: async () => [{
                _id: purchaseId,
                currency: 'GBP',
                date: new Date('2026-09-16T15:48:00Z'),
                createdAt: new Date('2026-09-16T15:48:00Z'),
                items: [{
                    _id: itemId,
                    category: { name: 'Mobile Phones' },
                    brand: 'APPLE',
                    brandModel: 'IPHONE 15',
                    capacity: '128GB',
                    colour: 'PINK',
                    grade: 'A',
                    purchasePrice: 140,
                    salePrice: 165,
                    imeis: ['S1', 'S2', 'S3', 'S4', 'S5'],
                }],
            }],
        }),
    }));
    serialIndexFind = jest.fn(() => ({
        select: () => ({
            lean: async () => [
                { serial: 'S1', status: 'in_stock' },
                { serial: 'S2', status: 'in_stock' }, // flipped by an earlier price edit — must be corrected
                { serial: 'S3', status: 'adjusted_out' },
                { serial: 'S5', status: 'in_transfer' },
            ],
        }),
    }));
    SerialIndex.find = serialIndexFind;
});
afterEach(() => {
    delete SoldSerial.find;
    delete Purchase.find;
    delete SerialIndex.find;
});

it('refreshes prices for in-stock IMEIs and keeps every other status', async () => {
    await reindexSerialsFromPurchases(['S1', 'S2', 'S3', 'S4', 'S5', ' S1 '], 'fonewarehouse');

    // In stock: full product with the new prices.
    expect(serialIndexService.upsertFromResult).toHaveBeenCalledTimes(1);
    const [tenant, result] = serialIndexService.upsertFromResult.mock.calls[0];
    expect(tenant).toBe('fonewarehouse');
    expect(result).toMatchObject({ serial: 'S1', status: 'in_stock', product: { price: 165, unitCost: 140 } });

    const bySerial = Object.fromEntries(serialIndexService.upsertSerialIndex.mock.calls.map(([, p]) => [p.serial, p]));
    // Sold: status (and sale reference) only — never back to in stock.
    expect(bySerial.S2).toEqual({ serial: 'S2', status: 'sold', saleReferenceSnapshot: 'INV-000141', customerNameSnapshot: 'Rehman' });
    // Written off / in transfer: status kept, prices refreshed.
    expect(bySerial.S3).toEqual({ serial: 'S3', status: 'adjusted_out', unitCost: 140, salePrice: 165 });
    expect(bySerial.S5).toEqual({ serial: 'S5', status: 'in_transfer', unitCost: 140, salePrice: 165 });
    // Returned to supplier.
    expect(bySerial.S4).toEqual({ serial: 'S4', status: 'returned_to_supplier' });
    // Nothing marks a non-in-stock IMEI as in stock.
    for (const [, p] of serialIndexService.upsertSerialIndex.mock.calls) expect(p.status).not.toBe('in_stock');
});

it('looks serials up in chunks of 500', async () => {
    const serials = Array.from({ length: 1201 }, (_, i) => `X${i}`);
    await reindexSerialsFromPurchases(serials, 'fonewarehouse');
    expect(serialIndexFind).toHaveBeenCalledTimes(3);
    const sizes = serialIndexFind.mock.calls.map(([q]) => q.serial.$in.length);
    expect(sizes).toEqual([500, 500, 201]);
});

it('does nothing without serials', async () => {
    await reindexSerialsFromPurchases([], 'fonewarehouse');
    expect(serialIndexFind).not.toHaveBeenCalled();
});
