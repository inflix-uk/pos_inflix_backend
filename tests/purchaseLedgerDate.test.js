/**
 * The supplier statement dates a purchase by its ledger line. Editing the purchase date must move
 * that line too, otherwise the statement keeps the old date. No DB: models are mocked.
 */

jest.mock('../src/services/auditService', () => ({ logFromReq: jest.fn(async () => {}) }));
jest.mock('../src/services/activityLogService', () => ({ logParcelEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/stockItemService', () => ({ rebuildForPurchase: jest.fn(async () => {}) }));
jest.mock('../src/lib/cache', () => {
    const actual = jest.requireActual('../src/lib/cache');
    return { ...actual, bumpMany: jest.fn(async () => {}), bumpNs: jest.fn(async () => {}) };
});

const Purchase = require('../src/models/Purchase');
const LedgerEntry = require('../src/models/LedgerEntry');
const { updatePurchaseDetails } = require('../src/controllers/purchaseController');

const purchaseId = '65f0a1b2c3d4e5f6a7b8c9d0';
const supplierId = '65f0a1b2c3d4e5f6a7b8c9d2';
const OLD_DATE = new Date('2026-01-24T00:00:00.000Z');

function populated(doc) {
    const chain = {
        populate: () => chain,
        then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
    };
    return chain;
}

function purchaseDoc(date) {
    const plain = { _id: purchaseId, purchaseNumber: 'PUR-000214', supplier: supplierId, date, items: [] };
    return { ...plain, toObject: () => ({ ...plain }) };
}

async function callDetails(body) {
    const req = { params: { id: purchaseId }, body, user: { id: 'u1', _id: 'u1' }, tenantId: 'fonewarehouse' };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await updatePurchaseDetails(req, res, (err) => { if (err) throw err; });
    return res;
}

let ledgerUpdateMany;

beforeEach(() => {
    jest.clearAllMocks();
    Purchase.findOne = jest.fn(async () => purchaseDoc(OLD_DATE));
    ledgerUpdateMany = jest.fn(async () => ({ modifiedCount: 1 }));
    LedgerEntry.updateMany = ledgerUpdateMany;
});

afterEach(() => {
    delete Purchase.findOne;
    delete Purchase.findOneAndUpdate;
    delete LedgerEntry.updateMany;
});

test('changing the purchase date moves its supplier ledger line to the new date', async () => {
    const newDate = new Date('2026-09-30T00:00:00.000Z');
    Purchase.findOneAndUpdate = jest.fn(() => populated(purchaseDoc(newDate)));

    const res = await callDetails({ date: '2026-09-30', supplier: supplierId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ledgerUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = ledgerUpdateMany.mock.calls[0];
    expect(filter).toEqual({ referenceId: purchaseId, type: 'purchase', deletedAt: null });
    expect(update.$set.date.toISOString()).toBe('2026-09-30T00:00:00.000Z');
});

test('saving details with the same date leaves the ledger alone', async () => {
    Purchase.findOneAndUpdate = jest.fn(() => populated(purchaseDoc(new Date(OLD_DATE))));

    const res = await callDetails({ date: '2026-01-24', note: 'edited note', supplier: supplierId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ledgerUpdateMany).not.toHaveBeenCalled();
});
