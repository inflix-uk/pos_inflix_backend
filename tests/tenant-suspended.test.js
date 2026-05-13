/**
 * Tenant suspension (requireTenantActive) and route gate.
 * - Normal user + suspended tenant -> 403 TENANT_SUSPENDED (GET and POST).
 * - Platform admin bypass works.
 * - /api/auth and /api/platform excluded from gate.
 */
const mongoose = require('mongoose');

describe('requireTenantActive', () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };
  const next = jest.fn();

  beforeEach(() => {
    next.mockClear();
    jest.resetModules();
  });

  it('returns 401 when req.user is missing', async () => {
    const { requireTenantActive } = require('../src/middleware/auth');
    const req = { user: null };
    const res = mockRes();
    await requireTenantActive(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'Not authorized' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 with code TENANT_SUSPENDED when tenant is suspended', async () => {
    const Tenant = require('../src/models/Tenant');
    const findOneSpy = jest.spyOn(Tenant, 'findOne').mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ tenantId: 'suspended-tenant', status: 'suspended' }),
    });
    const { requireTenantActive } = require('../src/middleware/auth');
    const req = {
      user: { _id: new mongoose.Types.ObjectId(), email: 'user@tenant.com', tenantId: 'suspended-tenant' },
    };
    const res = mockRes();
    await requireTenantActive(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'TENANT_SUSPENDED',
        message: expect.stringMatching(/suspended|Inflix/i),
      })
    );
    expect(next).not.toHaveBeenCalled();
    findOneSpy.mockRestore();
  });

  it('calls next() when tenant is active', async () => {
    if (!process.env.MONGODB_URI) return;
    const Tenant = require('../src/models/Tenant');
    const tid = 'active-tenant-' + Date.now();
    await Tenant.findOneAndUpdate(
      { tenantId: tid },
      { $set: { tenantId: tid, name: 'Active', companyName: 'Active', status: 'active' } },
      { upsert: true }
    );
    const { requireTenantActive } = require('../src/middleware/auth');
    const req = {
      user: { _id: new mongoose.Types.ObjectId(), email: 'u@t.com', tenantId: tid },
    };
    const res = mockRes();
    await requireTenantActive(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    await Tenant.deleteOne({ tenantId: tid });
  });

  it('platform admin bypasses suspension (calls next)', async () => {
    const Tenant = require('../src/models/Tenant');
    jest.spyOn(Tenant, 'findOne').mockResolvedValue({ tenantId: 'suspended-tenant', status: 'suspended' });
    const origEnv = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ADMIN_EMAILS = 'admin@platform.com,other@platform.com';
    const { requireTenantActive } = require('../src/middleware/auth');
    const req = {
      user: { _id: new mongoose.Types.ObjectId(), email: 'admin@platform.com', tenantId: 'suspended-tenant' },
    };
    const res = mockRes();
    await requireTenantActive(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    process.env.PLATFORM_ADMIN_EMAILS = origEnv;
    Tenant.findOne.mockRestore();
  });
});

describe('tenantActiveGate path exclusion', () => {
  it('routes index mounts tenantActiveGate and excludes auth and platform', () => {
    const index = require('../src/routes/index.js');
    const stack = index.stack || [];
    const hasGate = stack.some((layer) => layer.name === 'tenantActiveGate' || (layer.route && layer.route.stack && layer.route.stack.some((s) => s.name === 'tenantActiveGate')));
    const fs = require('fs');
    const path = require('path');
    const indexContent = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
    expect(indexContent).toContain('tenantActiveGate');
    expect(indexContent).toContain('requireTenantActive');
    expect(indexContent).toContain("p === 'auth'");
    expect(indexContent).toContain("p === 'platform'");
  });
});
