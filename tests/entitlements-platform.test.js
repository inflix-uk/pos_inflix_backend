/**
 * Feature Registry & Entitlements: getEntitlements, assertFeature, assertLimit, platform catalog.
 */
const mongoose = require('mongoose');
const FeatureCatalog = require('../src/models/FeatureCatalog');
const LimitCatalog = require('../src/models/LimitCatalog');
const PlanCatalog = require('../src/models/PlanCatalog');
const TenantSubscription = require('../src/models/TenantSubscription');
const entitlementsService = require('../src/services/entitlementsService');

describe('entitlementsService', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe('getEntitlements', () => {
    it('returns enabledFeatures and limits from plan when tenant has subscription', async () => {
      if (!process.env.MONGODB_URI) return;
      const sub = await TenantSubscription.findOne({ tenantId: 'default' }).lean();
      const plan = sub ? await PlanCatalog.findOne({ planKey: sub.planKey }).lean() : null;
      if (!plan) {
        const ent = await entitlementsService.getEntitlements('default');
        expect(ent).toHaveProperty('enabledFeatures');
        expect(ent).toHaveProperty('limits');
        expect(ent).toHaveProperty('planKey');
        return;
      }
      const ent = await entitlementsService.getEntitlements('default');
      expect(ent.planKey).toBeDefined();
      expect(typeof ent.enabledFeatures).toBe('object');
      expect(typeof ent.limits).toBe('object');
    });

    it('returns starter defaults when tenant has no subscription', async () => {
      if (!process.env.MONGODB_URI) return;
      const ent = await entitlementsService.getEntitlements('nonexistent-tenant-id');
      expect(ent.planKey).toBe('starter');
      expect(ent.enabledFeatures).toBeDefined();
      expect(ent.limits).toBeDefined();
    });
  });

  describe('assertFeature', () => {
    it('does not throw when feature is enabled', async () => {
      if (!process.env.MONGODB_URI) return;
      await expect(entitlementsService.assertFeature('default', 'repairs')).resolves.not.toThrow();
    });

    it('throws with status 402 when feature is disabled', async () => {
      if (!process.env.MONGODB_URI) return;
      const tid = 'test-assert-feature-' + Date.now();
      await TenantSubscription.findOneAndUpdate(
        { tenantId: tid },
        { $set: { tenantId: tid, planKey: 'starter', overrides: { features: { repairs: false }, limits: {} }, updatedAtUtc: new Date() } },
        { upsert: true }
      );
      await expect(entitlementsService.assertFeature(tid, 'repairs')).rejects.toMatchObject({
        code: 'FEATURE_DISABLED',
        status: 402,
      });
      await TenantSubscription.deleteOne({ tenantId: tid });
    });
  });

  describe('assertLimit', () => {
    it('does not throw when under limit', async () => {
      if (!process.env.MONGODB_URI) return;
      await expect(entitlementsService.assertLimit('default', 'maxUsers', 1)).resolves.not.toThrow();
    });

    it('throws with status 402 when limit exceeded', async () => {
      if (!process.env.MONGODB_URI) return;
      const tid = 'test-assert-limit-' + Date.now();
      await TenantSubscription.findOneAndUpdate(
        { tenantId: tid },
        { $set: { tenantId: tid, planKey: 'starter', overrides: { features: {}, limits: { maxUsers: 2 } }, updatedAtUtc: new Date() } },
        { upsert: true }
      );
      await expect(entitlementsService.assertLimit(tid, 'maxUsers', 3)).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
        status: 402,
      });
      await TenantSubscription.deleteOne({ tenantId: tid });
    });
  });

  describe('getUsage', () => {
    it('returns usage counts with correct keys', async () => {
      if (!process.env.MONGODB_URI) return;
      const usage = await entitlementsService.getUsage('default');
      expect(usage).toHaveProperty('maxUsers');
      expect(usage).toHaveProperty('maxLocations');
      expect(usage).toHaveProperty('maxRepairsPerMonth');
      expect(typeof usage.maxUsers).toBe('number');
      expect(typeof usage.maxLocations).toBe('number');
      expect(typeof usage.maxRepairsPerMonth).toBe('number');
    });

    it('returns tenant-scoped usage (users and locations count by tenantId)', async () => {
      if (!process.env.MONGODB_URI) return;
      const User = require('../src/models/User');
      const Location = require('../src/models/Location');
      const tid = 'test-usage-tenant-' + Date.now();
      const beforeUsage = await entitlementsService.getUsage(tid);
      expect(beforeUsage.maxUsers).toBe(0);
      expect(beforeUsage.maxLocations).toBe(0);
      await User.create({ name: 'U1', email: `u1-${tid}@test.com`, password: 'password123', tenantId: tid });
      const afterUser = await entitlementsService.getUsage(tid);
      expect(afterUser.maxUsers).toBe(1);
      await Location.create({ name: 'Loc ' + tid, tenantId: tid, isActive: true });
      const afterLoc = await entitlementsService.getUsage(tid);
      expect(afterLoc.maxLocations).toBe(1);
      await User.deleteOne({ email: `u1-${tid}@test.com` });
      await Location.deleteOne({ name: 'Loc ' + tid });
    });
  });
});

describe('FeatureCatalog', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('has expected feature keys when seeded', async () => {
    if (!process.env.MONGODB_URI) return;
    const features = await FeatureCatalog.find({ isActive: true }).select('key').lean();
    const keys = features.map((f) => f.key);
    expect(keys).toContain('repairs');
    expect(keys).toContain('reports');
    expect(keys).toContain('inventory');
  });
});

describe('requireFeature uses req.user.tenantId and returns 402 when disabled', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('returns 402 when user.tenantId has reports feature disabled', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-req-feature-' + Date.now();
    await TenantSubscription.findOneAndUpdate(
      { tenantId: tid },
      { $set: { tenantId: tid, planKey: 'starter', overrides: { features: { reports: false }, limits: {} }, updatedAtUtc: new Date() } },
      { upsert: true }
    );
    const { requireFeature, getTenantIdFromReq } = require('../src/middleware/auth');
    const middleware = requireFeature('reports');
    const req = { user: { tenantId: tid, _id: new mongoose.Types.ObjectId() } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'FEATURE_DISABLED' }));
    await TenantSubscription.deleteOne({ tenantId: tid });
  });

  it('getTenantIdFromReq returns user.tenantId when set', () => {
    const { getTenantIdFromReq } = require('../src/middleware/auth');
    expect(getTenantIdFromReq({ user: { tenantId: 'my-tenant' } })).toBe('my-tenant');
    expect(getTenantIdFromReq({ user: {} })).toBe('default');
    expect(getTenantIdFromReq({})).toBe('default');
  });
});

describe('GET /api/entitlements response shape and usage', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('getMyEntitlements returns planKey, enabledFeatures, limits, usage', async () => {
    if (!process.env.MONGODB_URI) return;
    const entitlementsController = require('../src/controllers/entitlementsController');
    const req = { user: { _id: new mongoose.Types.ObjectId(), tenantId: 'default' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await entitlementsController.getMyEntitlements(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        planKey: expect.any(String),
        enabledFeatures: expect.any(Object),
        limits: expect.any(Object),
        usage: expect.objectContaining({
          maxUsers: expect.any(Number),
          maxLocations: expect.any(Number),
          maxRepairsPerMonth: expect.any(Number),
        }),
      }),
    }));
  });
});
