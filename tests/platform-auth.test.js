/**
 * Platform Owner auth: separate from tenant Users.
 * - Platform user can login and access /api/platform/*
 * - Tenant user cannot access /api/platform/* (401)
 * - Platform users not counted in tenant maxUsers usage
 */
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../src/config');

describe('Platform auth', () => {
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

  describe('requirePlatformAuth', () => {
    it('returns 401 when no token is provided', async () => {
      const { requirePlatformAuth } = require('../src/middleware/auth');
      const req = { headers: {} };
      const res = mockRes();
      await requirePlatformAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'Platform authentication required' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when tenant token (no aud: platform) is used', async () => {
      const secret = config.jwtSecret || 'test-tenant-secret';
      const tenantToken = jwt.sign(
        { id: new mongoose.Types.ObjectId(), role: 'admin' },
        secret,
        { expiresIn: '1h' }
      );
      const { requirePlatformAuth } = require('../src/middleware/auth');
      const req = {
        headers: { 'x-platform-auth': `Bearer ${tenantToken}` },
      };
      const res = mockRes();
      await requirePlatformAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() and sets req.platformUser when valid platform token is used', async () => {
      if (!process.env.MONGODB_URI) return;
      const PlatformUser = require('../src/models/PlatformUser');
      const email = 'platform-test-' + Date.now() + '@inflix.co.uk';
      const existing = await PlatformUser.findOne({ email });
      let platformUserDoc = existing;
      if (!platformUserDoc) {
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('TestPass1!', 10);
        platformUserDoc = await PlatformUser.create({
          email,
          passwordHash: hash,
          role: 'platform_admin',
          isActive: true,
        });
      }
      const platformToken = platformUserDoc.getSignedJwtToken();
      const { requirePlatformAuth } = require('../src/middleware/auth');
      const req = {
        headers: { 'x-platform-auth': `Bearer ${platformToken}` },
      };
      const res = mockRes();
      await requirePlatformAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.platformUser).toBeDefined();
      expect(req.platformUser.email).toBe(platformUserDoc.email);
      expect(req.platformUser.role).toBe('platform_admin');
      if (!existing) await PlatformUser.deleteOne({ email });
    });
  });

  describe('Platform user not in tenant usage', () => {
    it('getUsage counts only User collection, not PlatformUser', async () => {
      if (!process.env.MONGODB_URI) return;
      const entitlementsService = require('../src/services/entitlementsService');
      const User = require('../src/models/User');
      const PlatformUser = require('../src/models/PlatformUser');
      const tid = 'usage-test-tenant-' + Date.now();
      const userCountBefore = (await User.countDocuments({ tenantId: tid })) || 0;
      const platformCount = await PlatformUser.countDocuments();
      const usageBefore = await entitlementsService.getUsage(tid);
      expect(usageBefore.usersUsed).toBe(userCountBefore);
      const platformEmail = 'not-tenant-' + Date.now() + '@platform.com';
      const bcrypt = require('bcryptjs');
      await PlatformUser.create({
        email: platformEmail,
        passwordHash: await bcrypt.hash('x', 10),
        role: 'platform_admin',
        isActive: true,
      });
      const usageAfter = await entitlementsService.getUsage(tid);
      expect(usageAfter.usersUsed).toBe(userCountBefore);
      await PlatformUser.deleteOne({ email: platformEmail });
    });
  });
});
