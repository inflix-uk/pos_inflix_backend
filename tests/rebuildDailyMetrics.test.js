/**
 * Rebuild-daily-metrics script tests (no DB required).
 *
 * The script writes to live tenant databases, so the write shape is pinned here:
 * correct totals, repair/stock counters left alone, stale rows zeroed, --dry-run writing nothing.
 */

const mockSaleRows = [];
const mockReturnRows = [];
const mockExistingLocation = [];
const mockExistingTenant = [];
const mockBulkWrites = [];

function mockAggregateStub(source) {
  return { aggregate: () => Promise.resolve(source.slice()) };
}

function mockMetricStub(name, existing) {
  return {
    find: () => ({ select: () => ({ lean: () => Promise.resolve(existing.slice()) }) }),
    bulkWrite: (ops) => {
      mockBulkWrites.push({ model: name, ops });
      return Promise.resolve({ ok: 1 });
    },
  };
}

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  connection: { useDb: () => ({ name: 'tenant_test' }) },
}));

jest.mock('../src/lib/tenantContext', () => ({ run: (_store, fn) => fn() }));
jest.mock('../src/models/Sale', () => mockAggregateStub(mockSaleRows));
jest.mock('../src/models/SalesReturn', () => mockAggregateStub(mockReturnRows));
jest.mock('../src/models/LocationDailyMetric', () =>
  mockMetricStub('LocationDailyMetric', mockExistingLocation)
);
jest.mock('../src/models/TenantDailyMetric', () =>
  mockMetricStub('TenantDailyMetric', mockExistingTenant)
);

const { rebuildTenant, parseArgs } = require('../src/scripts/rebuild-daily-metrics');

const LOC_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const LOC_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function seed({ sales = [], returns = [], existingLocation = [], existingTenant = [] }) {
  mockSaleRows.length = 0;
  mockReturnRows.length = 0;
  mockExistingLocation.length = 0;
  mockExistingTenant.length = 0;
  mockBulkWrites.length = 0;
  mockSaleRows.push(...sales);
  mockReturnRows.push(...returns);
  mockExistingLocation.push(...existingLocation);
  mockExistingTenant.push(...existingTenant);
}

const saleRow = (locationId, dateKey, gross, count) => ({
  _id: { locationId, dateKey },
  salesRevenueGross: gross,
  salesCount: count,
});

const opsFor = (model) => (mockBulkWrites.find((w) => w.model === model)?.ops ?? []);
const setFor = (model, match) =>
  opsFor(model).find((o) => Object.entries(match).every(([k, v]) => o.updateOne.filter[k] === v))
    ?.updateOne.update.$set;

describe('rebuild-daily-metrics', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    console.log.mockRestore();
  });

  it('parses tenant, window and dry-run flags', () => {
    const opts = parseArgs(['--tenant=gtl,Fonewarehouse', '--from=2026-08-01', '--to=2026-09-20', '--dry-run']);
    expect(opts.tenants).toEqual(['gtl', 'fonewarehouse']);
    expect(opts.from).toBe('2026-08-01');
    expect(opts.to).toBe('2026-09-20');
    expect(opts.dryRun).toBe(true);
    expect(parseArgs(['--all']).all).toBe(true);
  });

  it('rewrites an under-reported day to the live total', async () => {
    seed({
      sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8)],
      existingLocation: [{ locationId: LOC_A, dateKey: '2026-09-18', salesRevenueGross: 44.5, salesCount: 4 }],
      existingTenant: [{ dateKey: '2026-09-18', salesRevenueGross: 44.5, salesCount: 4 }],
    });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });

    expect(setFor('LocationDailyMetric', { locationId: LOC_A })).toMatchObject({
      salesRevenueGross: 339.5,
      salesCount: 8,
      returnsGross: 0,
      returnsCount: 0,
    });
    expect(setFor('TenantDailyMetric', { dateKey: '2026-09-18' })).toMatchObject({
      salesRevenueGross: 339.5,
      salesCount: 8,
    });
  });

  it('never writes repair or stock counters', async () => {
    seed({ sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8)] });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });

    const written = [...opsFor('LocationDailyMetric'), ...opsFor('TenantDailyMetric')];
    expect(written.length).toBeGreaterThan(0);
    for (const op of written) {
      expect(Object.keys(op.updateOne.update.$set).sort()).toEqual([
        'returnsCount',
        'returnsGross',
        'salesCount',
        'salesRevenueGross',
        'updatedAtUtc',
      ]);
    }
  });

  it('sums sales and returns onto the tenant row across locations', async () => {
    seed({
      sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8), saleRow(LOC_B, '2026-09-18', 139, 8)],
      returns: [{ _id: { locationId: LOC_B, dateKey: '2026-09-18' }, returnsGross: 20, returnsCount: 1 }],
    });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });

    expect(setFor('TenantDailyMetric', { dateKey: '2026-09-18' })).toMatchObject({
      salesRevenueGross: 478.5,
      salesCount: 16,
      returnsGross: 20,
      returnsCount: 1,
    });
    expect(setFor('LocationDailyMetric', { locationId: LOC_B })).toMatchObject({
      salesRevenueGross: 139,
      returnsGross: 20,
      returnsCount: 1,
    });
  });

  it('zeroes rollup rows whose source events are gone', async () => {
    seed({
      sales: [],
      existingLocation: [{ locationId: LOC_A, dateKey: '2026-09-18', salesRevenueGross: 44.5, salesCount: 4 }],
      existingTenant: [{ dateKey: '2026-09-18', salesRevenueGross: 44.5, salesCount: 4 }],
    });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });

    expect(setFor('LocationDailyMetric', { locationId: LOC_A })).toMatchObject({
      salesRevenueGross: 0,
      salesCount: 0,
    });
  });

  it('leaves already-correct rows untouched', async () => {
    seed({
      sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8)],
      existingLocation: [{ locationId: LOC_A, dateKey: '2026-09-18', salesRevenueGross: 339.5, salesCount: 8 }],
      existingTenant: [{ dateKey: '2026-09-18', salesRevenueGross: 339.5, salesCount: 8 }],
    });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });
    expect(mockBulkWrites).toHaveLength(0);
  });

  it('restricts writes to the requested date window', async () => {
    seed({
      sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8), saleRow(LOC_A, '2026-07-01', 99, 2)],
    });
    await rebuildTenant('gtl', { dryRun: false, from: '2026-09-01', to: '2026-09-30' });

    const dateKeys = opsFor('LocationDailyMetric').map((o) => o.updateOne.filter.dateKey);
    expect(dateKeys).toEqual(['2026-09-18']);
  });

  it('writes nothing on --dry-run', async () => {
    seed({
      sales: [saleRow(LOC_A, '2026-09-18', 339.5, 8)],
      existingLocation: [{ locationId: LOC_A, dateKey: '2026-09-18', salesRevenueGross: 44.5, salesCount: 4 }],
    });
    await rebuildTenant('gtl', { dryRun: true, from: null, to: null });
    expect(mockBulkWrites).toHaveLength(0);
  });

  it('skips location rows for events with no location, but still counts them for the tenant', async () => {
    seed({ sales: [saleRow(null, '2026-09-18', 50, 1)] });
    await rebuildTenant('gtl', { dryRun: false, from: null, to: null });

    expect(opsFor('LocationDailyMetric')).toHaveLength(0);
    expect(setFor('TenantDailyMetric', { dateKey: '2026-09-18' })).toMatchObject({
      salesRevenueGross: 50,
      salesCount: 1,
    });
  });
});
