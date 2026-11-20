/**
 * "Allow credit" must work on the backend, not only on screen:
 *  - unchecking it is saved on the customer (creditAllowed: false reaches the database update);
 *  - a wholesale sale that leaves money owing is then refused by the API — Walk-in included —
 *    before anything is written.
 * No DB: models and services are mocked.
 */

jest.mock('../src/services/transactionService', () => ({ runWithTransaction: jest.fn(async (fn) => fn(null)) }));
jest.mock('../src/utils/enrichSaleItemsFromPurchase', () => ({ enrichSaleItemsFromPurchase: jest.fn(async (items) => items) }));
jest.mock('../src/utils/effectiveRetailMode', () => ({ getEffectiveRetailModeEnabled: jest.fn(async () => false) }));
jest.mock('../src/lib/cache', () => {
    const actual = jest.requireActual('../src/lib/cache');
    return { ...actual, bumpMany: jest.fn(async () => {}), bumpNs: jest.fn(async () => {}) };
});

const Customer = require('../src/models/Customer');
const Sale = require('../src/models/Sale');
const GeneralSettings = require('../src/models/GeneralSettings');
const transactionService = require('../src/services/transactionService');
const { updateCustomer } = require('../src/controllers/customerController');
const { createSale } = require('../src/controllers/salesController');

const CUSTOMER_ID = '65f0a1b2c3d4e5f6a7b8c9d1';

function mockRes() {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    return res;
}

function run(handler, req) {
    const res = mockRes();
    return handler(req, res, (err) => { if (err) throw err; }).then(() => res);
}

afterEach(() => {
    jest.clearAllMocks();
    delete Customer.findOne;
    delete Customer.findByIdAndUpdate;
    delete Customer.findById;
    delete Sale.findOne;
    delete GeneralSettings.getSettings;
});

describe('saving "Allow credit"', () => {
    test('schema keeps creditAllowed / creditLimit (not stripped as unknown fields)', () => {
        const doc = new Customer({ name: 'Walk-in Customer', phone: 'N/A', creditAllowed: false, creditLimit: '5000' });
        expect(doc.creditAllowed).toBe(false);
        expect(doc.creditLimit).toBe(5000);
        // Defaults for customers saved before the feature existed.
        const legacy = new Customer({ name: 'Old', phone: '1' });
        expect(legacy.creditAllowed).toBe(true);
        expect(legacy.creditLimit).toBe(0);
    });

    test('unchecking Allow credit is written to the database', async () => {
        Customer.findOne = jest.fn(async () => ({ _id: CUSTOMER_ID }));
        // Keep our own handle: the tenant model proxy hands back a bound copy without `.mock`.
        const findByIdAndUpdate = jest.fn(async (_id, body) => ({ _id: CUSTOMER_ID, ...body }));
        Customer.findByIdAndUpdate = findByIdAndUpdate;
        const req = {
            params: { id: CUSTOMER_ID },
            tenantId: 'tbm',
            user: { _id: 'u1', role: 'admin' },
            body: { name: 'Walk-in Customer', phone: 'N/A', creditAllowed: false, creditLimit: '' },
        };
        const res = await run(updateCustomer, req);
        expect(res.status).toHaveBeenCalledWith(200);
        const [, update] = findByIdAndUpdate.mock.calls[0];
        expect(update.creditAllowed).toBe(false);
        expect(update.creditLimit).toBe(0);
    });
});

describe('credit sale is refused by the API', () => {
    function wholesaleSaleReq(customerId) {
        return {
            tenantId: 'tbm',
            user: { _id: 'u1', id: 'u1', role: 'admin' },
            body: {
                type: 'wholesale',
                customerId,
                customerName: 'Walk-in Customer',
                items: [{ sku: 'MISC-1', name: 'TEST', price: 1, quantity: 1 }],
                subtotal: 1,
                total: 1,
                discount: 0,
                previousBalance: 0,
                // Nothing paid: £1 left on credit (the INV-002717 case).
                payments: { cash: 0, card: 0, bank: 0, credit: 1 },
            },
        };
    }

    beforeEach(() => {
        Sale.findOne = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
        GeneralSettings.getSettings = jest.fn(async () => ({ accountBalanceAtCheckoutEnabled: false }));
    });

    test('Walk-in with Allow credit unchecked: 400 CREDIT_NOT_ALLOWED, no sale written', async () => {
        Customer.findOne = jest.fn(() => ({
            select: () => ({
                lean: async () => ({ _id: CUSTOMER_ID, name: 'Walk-in Customer', isWalkIn: true, balance: 1262, creditAllowed: false, creditLimit: 0 }),
            }),
        }));
        const res = await run(createSale, wholesaleSaleReq(CUSTOMER_ID));
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'CREDIT_NOT_ALLOWED' });
        expect(transactionService.runWithTransaction).not.toHaveBeenCalled();
    });

    test('over the maximum credit: 400 CREDIT_LIMIT_EXCEEDED, no sale written', async () => {
        Customer.findOne = jest.fn(() => ({
            select: () => ({
                lean: async () => ({ _id: CUSTOMER_ID, name: 'Shop A', balance: 1000, creditAllowed: true, creditLimit: 1000 }),
            }),
        }));
        const res = await run(createSale, wholesaleSaleReq(CUSTOMER_ID));
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'CREDIT_LIMIT_EXCEEDED' });
        expect(transactionService.runWithTransaction).not.toHaveBeenCalled();
    });
});
