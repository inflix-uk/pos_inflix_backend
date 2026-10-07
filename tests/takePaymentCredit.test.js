/**
 * "Take payment" on an invoice lowers what is still owed everywhere it is shown: amountDue and
 * payments.credit ("Balance to pay" / "Due"). Before, payments.credit kept the old figure, so a
 * paid invoice still said the customer owed it. No DB: models and services are mocked.
 */

jest.mock('../src/services/transactionService', () => ({ runWithTransaction: jest.fn(async (fn) => fn(null)) }));
jest.mock('../src/services/paymentAccountService', () => ({ getPaymentAccountIdForMethod: jest.fn(async () => null) }));
jest.mock('../src/lib/cache', () => {
    const actual = jest.requireActual('../src/lib/cache');
    return { ...actual, bumpMany: jest.fn(async () => {}), bumpNs: jest.fn(async () => {}) };
});

const Sale = require('../src/models/Sale');
const Customer = require('../src/models/Customer');
const LedgerEntry = require('../src/models/LedgerEntry');
const { takePayment } = require('../src/controllers/salesController');

const CUSTOMER_ID = '65f0a1b2c3d4e5f6a7b8c9d1';

function saleDoc(overrides) {
    const doc = {
        _id: '65f0a1b2c3d4e5f6a7b8c9d0', tenantId: 'fonewarehouse', status: 'active', reference: 'INV-000002',
        type: 'wholesale', customerId: CUSTOMER_ID, locationId: null,
        total: 190, amountDue: 190, payments: { cash: 0, card: 0, bank: 0, credit: 190 }, paymentHistory: [],
        save: jest.fn(async () => doc),
        ...overrides,
    };
    return doc;
}

async function pay(doc, body) {
    Sale.findOne = jest.fn(async () => doc);
    const req = { params: { id: doc._id }, tenantId: 'fonewarehouse', user: { _id: 'u1', role: 'admin' }, body };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await takePayment(req, res, (err) => { if (err) throw err; });
    return res;
}

let ledgerCreate;
beforeEach(() => {
    Customer.findOne = jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: CUSTOMER_ID, name: 'Mukhtar' }) }) }));
    Customer.findByIdAndUpdate = jest.fn(async () => null);
    ledgerCreate = jest.fn(async () => []);
    LedgerEntry.create = ledgerCreate;
});
afterEach(() => {
    delete Sale.findOne;
    delete Customer.findOne;
    delete Customer.findByIdAndUpdate;
    delete LedgerEntry.create;
});

test('paying an invoice in full leaves nothing to pay and posts the payment to the account', async () => {
    const doc = saleDoc();
    const res = await pay(doc, { amount: 190, paymentMethod: 'cash' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.amountDue).toBe(0);
    expect(doc.payments).toMatchObject({ cash: 190, credit: 0 });
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate.mock.calls[0][0][0]).toMatchObject({ type: 'payment_in', amount: -190, referenceLabel: 'INV-000002 payment' });
});

test('a part payment leaves the rest to pay', async () => {
    const doc = saleDoc();
    await pay(doc, { amount: 60, paymentMethod: 'bank' });

    expect(doc.amountDue).toBe(130);
    expect(doc.payments).toMatchObject({ bank: 60, credit: 130 });
});

test('a retail credit sale (no amount due recorded) has its credit lowered by the payment', async () => {
    const doc = saleDoc({ type: 'retail', customerId: null, amountDue: 0, payments: { cash: 0, card: 0, bank: 0, credit: 50 } });
    await pay(doc, { amount: 20, paymentMethod: 'card' });

    expect(doc.payments).toMatchObject({ card: 20, credit: 30 });
});
