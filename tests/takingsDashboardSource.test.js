/**
 * Takings Dashboard source-of-truth regression (no DB required).
 *
 * Guards the bug where salesCount/grossSales/refunds were read from the
 * LocationDailyMetric/TenantDailyMetric rollups while the payment breakdown and COGS were read
 * live. Those rollups are maintained by fire-and-forget $inc calls, so dropped increments made the
 * report contradict itself (e.g. 96 sales / GBP 1,975.52 against GBP 9,782.50 of payments taken,
 * and gross profit going negative). The dashboard must aggregate Sale/SalesReturn directly.
 */

// 8 live sales worth 339.50, paid 5.00 cash + 334.50 card. The stale rollup only ever saw 4 of
// them (44.50) — the shape that produced the negative gross profit in production.
const mockSalesTotal = 339.5;
const mockSalesCount = 8;
const mockCogs = 155.8;

const mockAggregateCalls = [];

/** Model stub: records the pipeline, replies from `responder`. Mirrors `.aggregate().option()`. */
function mockModelStub(name, responder) {
  return {
    modelName: name,
    aggregate: (pipeline) => {
      mockAggregateCalls.push({ model: name, pipeline });
      return { option: () => Promise.resolve(responder(pipeline)) };
    },
  };
}

const mockHas = (pipeline, needle) => JSON.stringify(pipeline).includes(needle);

jest.mock('../src/lib/redis', () => ({
  getDashboardCache: jest.fn().mockResolvedValue(null),
  setDashboardCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/middleware/auth', () => ({
  getTenantIdFromReq: () => 'test-tenant',
}));

jest.mock('../src/models/Sale', () =>
  mockModelStub('Sale', (pipeline) => {
    if (mockHas(pipeline, '"cashIn"')) {
      return [{ _id: null, cashIn: 5, cardIn: 334.5, bankIn: 0, creditIn: 0 }];
    }
    if (mockHas(pipeline, '$unwind')) return [{ _id: null, cogs: mockCogs }];
    if (mockHas(pipeline, '"status":"voided"')) return [{ _id: null, count: 1, total: 20 }];
    return [{ _id: null, total: mockSalesTotal, count: mockSalesCount }];
  })
);

jest.mock('../src/models/SalesReturn', () => mockModelStub('SalesReturn', () => []));
// A tenant WITH payment accounts: the ledger carries period activity, including an older-invoice
// settlement taken today. IN must still come from the period's sales; OUT still comes from here.
jest.mock('../src/models/PaymentLedgerEntry', () =>
  mockModelStub('PaymentLedgerEntry', (pipeline) => {
    if (mockHas(pipeline, '$lookup')) return [];
    return [
      { _id: 'cash', in: 900, out: 0 },
      { _id: 'card', in: 334.5, out: 12 },
    ];
  })
);
jest.mock('../src/models/Expense', () => mockModelStub('Expense', () => []));

jest.mock('../src/models/Location', () => ({
  findById: () => ({
    select: () => ({ lean: () => Promise.resolve({ name: 'Galaxt Techno - Wantage' }) }),
  }),
}));

// Rollup models must never be queried. Touching them fails the test loudly.
jest.mock('../src/models/LocationDailyMetric', () =>
  mockModelStub('LocationDailyMetric', () => {
    throw new Error('LocationDailyMetric must not be used by the takings dashboard');
  })
);
jest.mock('../src/models/TenantDailyMetric', () =>
  mockModelStub('TenantDailyMetric', () => {
    throw new Error('TenantDailyMetric must not be used by the takings dashboard');
  })
);

const controller = require('../src/controllers/takingsDashboardController');

const LOCATION_ID = '69cbf015e291b8e83a74347d';

async function callDashboard(query) {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const req = { query, user: { role: 'admin', tenantId: 'test-tenant' } };
  await controller.getTakingsDashboard(req, res, (err) => {
    if (err) throw err;
  });
  const payload = res.json.mock.calls[0][0];
  expect(payload.success).toBe(true);
  return payload.data;
}

describe('Takings Dashboard reads Sale/SalesReturn, not the daily rollups', () => {
  beforeEach(() => {
    mockAggregateCalls.length = 0;
  });

  it('never queries the daily-metric rollups', async () => {
    await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    const models = mockAggregateCalls.map((c) => c.model);
    expect(models).not.toContain('LocationDailyMetric');
    expect(models).not.toContain('TenantDailyMetric');
    expect(models).toContain('Sale');
  });

  it('reports live sales totals for a single location', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    expect(data.takings.salesCount).toBe(mockSalesCount);
    expect(data.takings.grossSales).toBe(mockSalesTotal);
    expect(data.takings.netRevenue).toBe(mockSalesTotal);
    expect(data.location.locationId).toBe(LOCATION_ID);
  });

  it('reconciles payments taken against gross sales', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    const pb = data.takings.paymentBreakdown;
    const totalIn = pb.cash.in + pb.card.in + pb.bank.in + pb.credit.in;
    expect(totalIn).toBe(mockSalesTotal);
    expect(totalIn - data.takings.refundsGross).toBe(data.takings.netRevenue);
  });

  it('keeps P&L revenue in step with takings, so gross profit stays sane', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    expect(data.profitAndLoss.revenue).toBe(data.takings.netRevenue);
    expect(data.profitAndLoss.cogs).toBe(mockCogs);
    expect(data.profitAndLoss.grossProfit).toBe(Math.round((mockSalesTotal - mockCogs) * 100) / 100);
    expect(data.profitAndLoss.grossProfit).toBeGreaterThan(0);
  });

  it('applies the same source for all locations', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: 'all' });
    expect(data.location.locationId).toBe('all');
    expect(data.takings.grossSales).toBe(mockSalesTotal);
    expect(mockAggregateCalls.map((c) => c.model)).not.toContain('TenantDailyMetric');
  });

  it('still bypasses the rollups on the shift (fromUtc/toUtc) path', async () => {
    const data = await callDashboard({
      from: '2026-09-18',
      to: '2026-09-18',
      locationId: LOCATION_ID,
      fromUtc: '2026-09-17T23:00:00.000Z',
      toUtc: '2026-09-18T22:59:59.999Z',
    });
    expect(data.takings.grossSales).toBe(mockSalesTotal);
    expect(data.range.fromUtc).toBe('2026-09-17T23:00:00.000Z');
  });

  it('takes payments IN from the sales in the period, not from ledger activity', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    const pb = data.takings.paymentBreakdown;
    // Ledger cash IN is 900 (it includes an older invoice settled today); the period's sales took 5.
    expect(pb.cash.in).toBe(5);
    expect(pb.card.in).toBe(334.5);
    expect(pb.cash.in + pb.card.in + pb.bank.in + pb.credit.in).toBe(mockSalesTotal);
  });

  it('keeps refunds OUT on the ledger, which knows the method refunded', async () => {
    const data = await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    expect(data.takings.paymentBreakdown.card.out).toBe(12);
    expect(data.takings.paymentBreakdown.card.net).toBe(322.5);
  });

  it('scopes expenses to the selected shop', async () => {
    await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: LOCATION_ID });
    const expenseMatches = mockAggregateCalls
      .filter((c) => c.model === 'Expense')
      .map((c) => c.pipeline[0].$match);
    expect(expenseMatches.length).toBe(2);
    for (const m of expenseMatches) {
      expect(String(m.locationId)).toBe(LOCATION_ID);
      expect(m.status).toEqual({ $in: ['Approved', 'Paid'] });
    }
  });

  it('leaves expenses unscoped for All locations, so company-wide overhead still shows', async () => {
    await callDashboard({ from: '2026-09-18', to: '2026-09-18', locationId: 'all' });
    const expenseMatches = mockAggregateCalls
      .filter((c) => c.model === 'Expense')
      .map((c) => c.pipeline[0].$match);
    expect(expenseMatches.length).toBe(2);
    for (const m of expenseMatches) {
      expect(m.locationId).toBeUndefined();
      expect(m.$or).toBeUndefined();
    }
  });
});
