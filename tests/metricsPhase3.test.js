/**
 * Phase 3: Metrics service and reports dashboard endpoints.
 * - incrementSaleCreated / incrementReturnCreated update LocationDailyMetric and TenantDailyMetric
 * - GET /api/reports/dashboard/summary and /by-location return expected shape
 */

const mongoose = require('mongoose');
const { getLondonDateKey } = require('../src/utils/dateKey');
const metricsService = require('../src/services/metricsService');
const LocationDailyMetric = require('../src/models/LocationDailyMetric');
const TenantDailyMetric = require('../src/models/TenantDailyMetric');
const redis = require('../src/lib/redis');

describe('dateKey London', () => {
  it('getLondonDateKey returns YYYY-MM-DD', () => {
    const key = getLondonDateKey(new Date('2025-03-12T12:00:00.000Z'));
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('metricsService', () => {
  const tid = 'test-tenant-metrics';
  const locationId = new mongoose.Types.ObjectId();
  let dateKey;

  beforeAll(async () => {
    if (!process.env.MONGODB_URI) return;
    await mongoose.connect(process.env.MONGODB_URI);
    dateKey = getLondonDateKey(new Date());
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await LocationDailyMetric.deleteMany({ tenantId: tid });
      await TenantDailyMetric.deleteMany({ tenantId: tid });
    }
    await mongoose.disconnect();
  });

  it('incrementSaleCreated creates/updates TenantDailyMetric and LocationDailyMetric', async () => {
    if (!process.env.MONGODB_URI) return;
    await metricsService.incrementSaleCreated(tid, locationId, 100, new Date());
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey });
    const loc = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey });
    expect(tenant).toBeDefined();
    expect(tenant.salesRevenueGross).toBe(100);
    expect(tenant.salesCount).toBe(1);
    expect(loc).toBeDefined();
    expect(loc.salesRevenueGross).toBe(100);
    expect(loc.salesCount).toBe(1);

    await metricsService.incrementSaleCreated(tid, locationId, 50, new Date());
    const tenant2 = await TenantDailyMetric.findOne({ tenantId: tid, dateKey });
    const loc2 = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey });
    expect(tenant2.salesRevenueGross).toBe(150);
    expect(tenant2.salesCount).toBe(2);
    expect(loc2.salesRevenueGross).toBe(150);
    expect(loc2.salesCount).toBe(2);
  });

  it('incrementReturnCreated updates returnsGross and returnsCount', async () => {
    if (!process.env.MONGODB_URI) return;
    await metricsService.incrementReturnCreated(tid, locationId, 25, new Date());
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey });
    const loc = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey });
    expect(tenant.returnsGross).toBe(25);
    expect(tenant.returnsCount).toBe(1);
    expect(loc.returnsGross).toBe(25);
    expect(loc.returnsCount).toBe(1);
  });

  it('incrementSaleCreated with null locationId only updates TenantDailyMetric', async () => {
    if (!process.env.MONGODB_URI) return;
    await metricsService.incrementSaleCreated(tid, null, 99, new Date());
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey });
    const locCount = await LocationDailyMetric.countDocuments({ tenantId: tid, dateKey });
    expect(tenant.salesRevenueGross).toBe(99);
    expect(tenant.salesCount).toBe(1);
    expect(locCount).toBe(0);
  });

  it('dateKey uses event timestamp not "today"', async () => {
    if (!process.env.MONGODB_URI) return;
    const eventDate = new Date('2020-06-15T14:00:00.000Z');
    const eventDateKey = getLondonDateKey(eventDate);
    expect(eventDateKey).toBe('2020-06-15');
    await metricsService.incrementSaleCreated(tid, locationId, 77, eventDate);
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey: eventDateKey });
    const loc = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey: eventDateKey });
    expect(tenant).toBeDefined();
    expect(tenant.salesRevenueGross).toBe(77);
    expect(loc).toBeDefined();
    expect(loc.salesRevenueGross).toBe(77);
  });

  it('decrementSaleVoided reverses sale metrics for event date', async () => {
    if (!process.env.MONGODB_URI) return;
    const eventDate = new Date('2021-01-10T10:00:00.000Z');
    const eventDateKey = getLondonDateKey(eventDate);
    await metricsService.incrementSaleCreated(tid, locationId, 200, eventDate);
    await metricsService.decrementSaleVoided(tid, locationId, 200, eventDate);
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey: eventDateKey });
    const loc = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey: eventDateKey });
    expect(tenant.salesRevenueGross).toBe(0);
    expect(tenant.salesCount).toBe(0);
    expect(loc.salesRevenueGross).toBe(0);
    expect(loc.salesCount).toBe(0);
  });

  it('saleTotalEditDelta applies revenue delta for event date', async () => {
    if (!process.env.MONGODB_URI) return;
    const eventDate = new Date('2022-03-01T09:00:00.000Z');
    const eventDateKey = getLondonDateKey(eventDate);
    await metricsService.incrementSaleCreated(tid, locationId, 100, eventDate);
    await metricsService.saleTotalEditDelta(tid, locationId, eventDate, 25);
    const tenant = await TenantDailyMetric.findOne({ tenantId: tid, dateKey: eventDateKey });
    const loc = await LocationDailyMetric.findOne({ tenantId: tid, locationId, dateKey: eventDateKey });
    expect(tenant.salesRevenueGross).toBe(125);
    expect(loc.salesRevenueGross).toBe(125);
  });
});

describe('reports dashboard summary/by-location', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('GET /dashboard/summary returns data shape', async () => {
    if (!process.env.MONGODB_URI) return;
    const controller = require('../src/controllers/reportsDashboardController');
    const req = {
      query: { from: '2020-01-01', to: '2030-12-31', locationId: 'all' },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getSummary(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveProperty('salesRevenueGross');
    expect(data).toHaveProperty('salesCount');
    expect(data).toHaveProperty('returnsGross');
    expect(data).toHaveProperty('repairsOpen');
  });

  it('GET /dashboard/by-location returns top and bottom', async () => {
    if (!process.env.MONGODB_URI) return;
    const controller = require('../src/controllers/reportsDashboardController');
    const req = {
      query: { from: '2020-01-01', to: '2030-12-31', metric: 'salesRevenueGross' },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getByLocation(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveProperty('top');
    expect(data).toHaveProperty('bottom');
    expect(data).toHaveProperty('metric', 'salesRevenueGross');
    expect(Array.isArray(data.top)).toBe(true);
    expect(Array.isArray(data.bottom)).toBe(true);
  });
});

describe('dashboard cache versioning (Redis)', () => {
  it('getDashboardCacheVersion returns a number when Redis available', async () => {
    const version = await redis.getDashboardCacheVersion();
    expect(typeof version).toBe('number');
    expect(version).toBeGreaterThanOrEqual(0);
  });

  it('set then get returns value (versioned key); incr invalidates', async () => {
    if (!process.env.REDIS_URL || process.env.REDIS_URL === '') return;
    const keySuffix = 'test:version:key:' + Date.now();
    const payload = { foo: 'bar', n: 1 };
    await redis.setDashboardCache(keySuffix, payload);
    const got = await redis.getDashboardCache(keySuffix);
    expect(got).toEqual(payload);
    await redis.incrDashboardCacheVersion();
    const afterIncr = await redis.getDashboardCache(keySuffix);
    expect(afterIncr).toBeNull();
    const newPayload = { foo: 'baz' };
    await redis.setDashboardCache(keySuffix, newPayload);
    const gotNew = await redis.getDashboardCache(keySuffix);
    expect(gotNew).toEqual(newPayload);
  });
});
