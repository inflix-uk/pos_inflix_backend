/**
 * Phase 2: Multi-location foundation tests.
 * - Sale/Repair locationId stored correctly
 * - Dashboard getLocationFilter parsing
 * - Dashboard with locationId returns filtered results (mocked)
 */

const mongoose = require('mongoose');
const { getLocationFilter } = require('../src/controllers/dashboardController');
const Sale = require('../src/models/Sale');
const Repair = require('../src/models/Repair');
const SalesReturn = require('../src/models/SalesReturn');
const transactionService = require('../src/services/transactionService');
const salesTransactionService = require('../src/services/salesTransactionService');

describe('Dashboard location filter', () => {
  describe('getLocationFilter', () => {
    it('returns null when no locationId or locationIds', () => {
      expect(getLocationFilter({})).toBeNull();
      expect(getLocationFilter({ locationId: '' })).toBeNull();
      expect(getLocationFilter({ locationIds: '' })).toBeNull();
    });

    it('returns single locationId filter for valid ObjectId', () => {
      const id = new mongoose.Types.ObjectId();
      const filter = getLocationFilter({ locationId: id.toString() });
      expect(filter).toEqual({ locationId: id });
    });

    it('returns null for invalid locationId', () => {
      expect(getLocationFilter({ locationId: 'not-an-id' })).toBeNull();
      expect(getLocationFilter({ locationId: '123' })).toBeNull();
    });

    it('returns $in filter for comma-separated locationIds', () => {
      const id1 = new mongoose.Types.ObjectId();
      const id2 = new mongoose.Types.ObjectId();
      const filter = getLocationFilter({ locationIds: `${id1},${id2}` });
      expect(filter).toEqual({ locationId: { $in: [id1, id2] } });
    });

    it('single locationId takes precedence over locationIds when both provided', () => {
      const singleId = new mongoose.Types.ObjectId();
      const filter = getLocationFilter({ locationId: singleId.toString(), locationIds: 'other' });
      expect(filter).toEqual({ locationId: singleId });
    });

    it('returns locationId null for "unknown"', () => {
      expect(getLocationFilter({ locationId: 'unknown' })).toEqual({ locationId: null });
      expect(getLocationFilter({ locationId: '__unknown__' })).toEqual({ locationId: null });
    });

    it('returns $in when userScope provided and no query location', () => {
      const id1 = new mongoose.Types.ObjectId().toString();
      const id2 = new mongoose.Types.ObjectId().toString();
      const filter = getLocationFilter({}, [id1, id2]);
      expect(filter).toEqual({ locationId: { $in: [new mongoose.Types.ObjectId(id1), new mongoose.Types.ObjectId(id2)] } });
    });

    it('query locationId overrides userScope', () => {
      const singleId = new mongoose.Types.ObjectId();
      const filter = getLocationFilter({ locationId: singleId.toString() }, ['other-id']);
      expect(filter).toEqual({ locationId: singleId });
    });
  });
});

describe('Sale model locationId', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('Sale schema has locationId field (nullable)', () => {
    const path = Sale.schema.path('locationId');
    expect(path).toBeDefined();
    expect(path.instance).toBe('ObjectId');
  });

  it('creates sale with locationId and stores correctly', async () => {
    if (!process.env.MONGODB_URI) return;
    const locationId = new mongoose.Types.ObjectId();
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'TEST-LOC', name: 'Test', price: 1, quantity: 1 }],
      subtotal: 1,
      total: 1,
      paymentMethod: 'cash',
      locationId,
    });
    expect(sale.locationId).toBeDefined();
    expect(sale.locationId.toString()).toBe(locationId.toString());
    await Sale.deleteOne({ _id: sale._id });
  });
});

describe('Dashboard endpoint with location (integration)', () => {
  beforeAll(async () => {
    if (!process.env.MONGODB_URI) return;
    await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('dashboard without location filter returns data (same as before)', async () => {
    if (!process.env.MONGODB_URI) return;
    const dashboard = require('../src/controllers/dashboardController');
    const req = {
      query: { fromUtc: '2020-01-01T00:00:00.000Z', toUtc: '2025-12-31T23:59:59.999Z' },
      user: { role: 'admin', permissionKeys: new Set(['sale.view', 'repair.view', 'product.view', 'purchase.view', 'accounts.view', 'audit.view']) },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await dashboard.getDashboard(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveProperty('kpis');
    expect(data).toHaveProperty('recentInvoices');
  });

  it('dashboard with locationId returns filtered result structure', async () => {
    if (!process.env.MONGODB_URI) return;
    const id = new mongoose.Types.ObjectId();
    const dashboard = require('../src/controllers/dashboardController');
    const req = {
      query: { fromUtc: '2020-01-01T00:00:00.000Z', toUtc: '2025-12-31T23:59:59.999Z', locationId: id.toString() },
      user: { role: 'admin', permissionKeys: new Set(['sale.view', 'repair.view', 'product.view', 'purchase.view', 'accounts.view', 'audit.view']) },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await dashboard.getDashboard(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveProperty('kpis');
    expect(data).toHaveProperty('recentInvoices');
  });
});

describe('Repair model locationId', () => {
  it('Repair schema has locationId field (nullable)', () => {
    const path = Repair.schema.path('locationId');
    expect(path).toBeDefined();
    expect(path.instance).toBe('ObjectId');
  });
});

describe('SalesReturn locationId from linked sale', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('SalesReturn schema has locationId field', () => {
    const path = SalesReturn.schema.path('locationId');
    expect(path).toBeDefined();
    expect(path.instance).toBe('ObjectId');
  });

  it('create return linked to sale sets locationId from sale', async () => {
    if (!process.env.MONGODB_URI) return;
    const locationId = new mongoose.Types.ObjectId();
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'SALE-FOR-RET', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      total: 10,
      paymentMethod: 'cash',
      locationId,
    });
    const ref = sale.reference;
    expect(ref).toBeDefined();

    const result = await transactionService.runWithTransaction(async (session) => {
      return await salesTransactionService.createSalesReturnInTransaction(
        session,
        {
          customerName: 'Test Customer',
          linkedInvoiceRef: ref,
          items: [
            { product: 'Item', sku: 'SALE-FOR-RET', netUnitPrice: 10, quantity: 1, subtotal: 10, serialNumbers: [], returnDestination: 'restock' },
          ],
        },
        { userId: null }
      );
    });

    expect(result.salesReturn.locationId).toBeDefined();
    expect(result.salesReturn.locationId.toString()).toBe(locationId.toString());

    await SalesReturn.deleteOne({ _id: result.salesReturn._id });
    await Sale.deleteOne({ _id: sale._id });
  });
});
