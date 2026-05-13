/**
 * Platform ↔ Tenant POS integration tests.
 * - platformClient headers (X-Platform-Secret, X-Tenant-Id)
 * - /api/entitlements returns platform response when configured (mocked)
 * - create user triggers USER_CREATED event (mocked)
 * - requireFeature blocks when feature disabled (platform entitlements)
 * - assertLimit blocks when platform usage at limit
 */

const platformClient = require('../src/lib/platformClient');

describe('platformClient', () => {
    it('getHeaders includes X-Platform-Secret and X-Tenant-Id', () => {
        const headers = platformClient.getHeaders();
        expect(headers).toHaveProperty('X-Platform-Secret');
        expect(headers).toHaveProperty('X-Tenant-Id');
        expect(typeof headers['X-Tenant-Id']).toBe('string');
    });

    it('fetchPlatformEntitlements sends X-Platform-Secret and X-Tenant-Id when fetch is mocked', async () => {
        let capturedOpts = null;
        const originalFetch = global.fetch;
        global.fetch = (url, opts) => {
            capturedOpts = opts;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    data: { planKey: 'starter', enabledFeatures: {}, limits: {}, usage: {} }
                })
            });
        };
        try {
            if (platformClient.isPlatformConfigured()) {
                await platformClient.fetchPlatformEntitlements();
                expect(capturedOpts?.headers).toHaveProperty('X-Platform-Secret');
                expect(capturedOpts?.headers).toHaveProperty('X-Tenant-Id');
            }
        } finally {
            global.fetch = originalFetch;
        }
    });
});

describe('entitlementsController with platform', () => {
    it('/api/entitlements response shape unchanged when using platform cache', async () => {
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const platformClient = require('../src/lib/platformClient');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'pro',
            enabledFeatures: { repairs: true },
            limits: { maxUsers: 10, maxLocations: 5, maxRepairsPerMonth: 100 },
            usage: { usersUsed: 2, locationsUsed: 1, repairsThisMonthUsed: 10 }
        });
        const isConfiguredSpy = jest.spyOn(platformClient, 'isPlatformConfigured').mockReturnValue(true);
        const Tenant = require('../src/models/Tenant');
        const TenantSubscription = require('../src/models/TenantSubscription');
        const tenantFindSpy = jest.spyOn(Tenant, 'findOne').mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
        const subFindSpy = jest.spyOn(TenantSubscription, 'findOne').mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
        try {
            const entitlementsController = require('../src/controllers/entitlementsController');
            const req = { user: { tenantId: 'default' } };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await entitlementsController.getMyEntitlements(req, res);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true,
                    data: expect.objectContaining({
                        planKey: 'pro',
                        enabledFeatures: expect.any(Object),
                        limits: expect.any(Object),
                        usage: expect.objectContaining({ usersUsed: 2, locationsUsed: 1, repairsThisMonthUsed: 10 })
                    })
                })
            );
        } finally {
            getEntitlementsSpy.mockRestore();
            isConfiguredSpy.mockRestore();
            tenantFindSpy.mockRestore();
            subFindSpy.mockRestore();
        }
    });
});

describe('adminController createUser emits USER_CREATED', () => {
    it('calls postPlatformEvent("USER_CREATED", 1, meta) when platform configured', async () => {
        const config = require('../src/config');
        const origBaseUrl = config.platformBaseUrl;
        config.platformBaseUrl = 'http://platform';
        const postSpy = jest.spyOn(platformClient, 'postPlatformEvent').mockResolvedValue(undefined);
        const isConfiguredSpy = jest.spyOn(platformClient, 'isPlatformConfigured').mockReturnValue(true);
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'starter',
            enabledFeatures: {},
            limits: { maxUsers: 10 },
            usage: { usersUsed: 0, locationsUsed: 0, repairsThisMonthUsed: 0 }
        });
        const activityLogService = require('../src/services/activityLogService');
        const logSpy = jest.spyOn(activityLogService, 'logFromReq').mockResolvedValue(undefined);
        const User = require('../src/models/User');
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(null);
        const countSpy = jest.spyOn(User, 'countDocuments').mockResolvedValue(0);
        const fakeUser = { _id: '507f1f77bcf86cd799439012', email: 'platform-event-test@test.com', name: 'Test' };
        const createSpy = jest.spyOn(User, 'create').mockResolvedValue(fakeUser);
        const findByIdSpy = jest.spyOn(User, 'findById').mockReturnValue({
            populate: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(fakeUser) })
            })
        });
        try {
            const adminController = require('../src/controllers/adminController');
            const req = {
                body: { name: 'Test', email: 'platform-event-test@test.com', password: 'Test123!ab', isActive: true },
                user: { _id: '507f1f77bcf86cd799439011' }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await adminController.createUser(req, res);
            expect(res.status).toHaveBeenCalledWith(201);
            expect(postSpy).toHaveBeenCalledWith('USER_CREATED', 1, expect.objectContaining({ email: 'platform-event-test@test.com' }));
        } finally {
            config.platformBaseUrl = origBaseUrl;
            postSpy.mockRestore();
            isConfiguredSpy.mockRestore();
            getEntitlementsSpy.mockRestore();
            logSpy.mockRestore();
            findOneSpy.mockRestore();
            countSpy.mockRestore();
            createSpy.mockRestore();
            findByIdSpy.mockRestore();
        }
    });
});

describe('requireFeature with platform entitlements', () => {
    it('blocks when feature disabled in platform cache', async () => {
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const config = require('../src/config');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'starter',
            enabledFeatures: { repairs: false },
            limits: {},
            usage: {}
        });
        const orig = config.platformBaseUrl;
        try {
            config.platformBaseUrl = 'http://platform';
            const entitlementsService = require('../src/services/entitlementsService');
            await expect(entitlementsService.assertFeature('default', 'repairs')).rejects.toMatchObject({
                code: 'FEATURE_DISABLED',
                status: 402
            });
        } finally {
            config.platformBaseUrl = orig;
            getEntitlementsSpy.mockRestore();
        }
    });
});

describe('assertLimit with platform usage', () => {
    it('blocks when platform usage at limit (maxUsers)', async () => {
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'starter',
            enabledFeatures: {},
            limits: { maxUsers: 2, maxLocations: 5, maxRepairsPerMonth: 100 },
            usage: { usersUsed: 2, locationsUsed: 0, repairsThisMonthUsed: 0 }
        });
        const config = require('../src/config');
        const orig = config.platformBaseUrl;
        try {
            config.platformBaseUrl = 'http://platform';
            const entitlementsService = require('../src/services/entitlementsService');
            await expect(entitlementsService.assertLimit('default', 'maxUsers', 3)).rejects.toMatchObject({
                code: 'LIMIT_EXCEEDED',
                status: 402
            });
        } finally {
            config.platformBaseUrl = orig;
            getEntitlementsSpy.mockRestore();
        }
    });

    it('when usersUsed=2 and maxUsers=2, creating a user throws LIMIT_EXCEEDED', async () => {
        const config = require('../src/config');
        const origBaseUrl = config.platformBaseUrl;
        config.platformBaseUrl = 'http://platform';
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'starter',
            enabledFeatures: {},
            limits: { maxUsers: 2 },
            usage: { usersUsed: 2, locationsUsed: 0, repairsThisMonthUsed: 0 }
        });
        const isConfiguredSpy = jest.spyOn(platformClient, 'isPlatformConfigured').mockReturnValue(true);
        const User = require('../src/models/User');
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(null);
        try {
            const adminController = require('../src/controllers/adminController');
            const req = {
                body: { name: 'Test', email: 'limit-exceeded@test.com', password: 'Test123!ab', isActive: true },
                user: { _id: '507f1f77bcf86cd799439011' }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await adminController.createUser(req, res);
            expect(res.status).toHaveBeenCalledWith(402);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ success: false, code: 'LIMIT_EXCEEDED' })
            );
        } finally {
            config.platformBaseUrl = origBaseUrl;
            getEntitlementsSpy.mockRestore();
            isConfiguredSpy.mockRestore();
            findOneSpy.mockRestore();
        }
    });

    it('when usersUsed=1 and maxUsers=2, creating a user passes and emits USER_CREATED', async () => {
        const config = require('../src/config');
        const origBaseUrl = config.platformBaseUrl;
        config.platformBaseUrl = 'http://platform';
        const postSpy = jest.spyOn(platformClient, 'postPlatformEvent').mockResolvedValue(undefined);
        const isConfiguredSpy = jest.spyOn(platformClient, 'isPlatformConfigured').mockReturnValue(true);
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({
            planKey: 'starter',
            enabledFeatures: {},
            limits: { maxUsers: 2 },
            usage: { usersUsed: 1, locationsUsed: 0, repairsThisMonthUsed: 0 }
        });
        const activityLogService = require('../src/services/activityLogService');
        const logSpy = jest.spyOn(activityLogService, 'logFromReq').mockResolvedValue(undefined);
        const User = require('../src/models/User');
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(null);
        const fakeUser = { _id: '507f1f77bcf86cd799439013', email: 'user-created-ok@test.com', name: 'Test' };
        const createSpy = jest.spyOn(User, 'create').mockResolvedValue(fakeUser);
        const findByIdSpy = jest.spyOn(User, 'findById').mockReturnValue({
            populate: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(fakeUser) })
            })
        });
        try {
            const adminController = require('../src/controllers/adminController');
            const req = {
                body: { name: 'Test', email: 'user-created-ok@test.com', password: 'Test123!ab', isActive: true },
                user: { _id: '507f1f77bcf86cd799439011' }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await adminController.createUser(req, res);
            expect(res.status).toHaveBeenCalledWith(201);
            expect(postSpy).toHaveBeenCalledWith('USER_CREATED', 1, expect.objectContaining({ email: 'user-created-ok@test.com' }));
        } finally {
            config.platformBaseUrl = origBaseUrl;
            postSpy.mockRestore();
            isConfiguredSpy.mockRestore();
            getEntitlementsSpy.mockRestore();
            logSpy.mockRestore();
            findOneSpy.mockRestore();
            createSpy.mockRestore();
            findByIdSpy.mockRestore();
        }
    });
});

describe('platformCallback (platform → tenant auth handoff)', () => {
    const jwt = require('jsonwebtoken');
    const config = require('../src/config');

    it('returns 400 when token is missing', async () => {
        const authController = require('../src/controllers/authController');
        const req = { body: {} };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await authController.platformCallback(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('token') }));
    });

    it('returns 401 when token is invalid or expired', async () => {
        if (!config.platformSharedSecret) return;
        const authController = require('../src/controllers/authController');
        const req = { body: { token: 'invalid.jwt.here' } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await authController.platformCallback(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringMatching(/invalid|expired/i) }));
    });

    it('returns 403 when payload.tenantId does not match TENANT_ID', async () => {
        if (!config.platformSharedSecret) return;
        const wrongTenantToken = jwt.sign(
            { tenantId: 'other-tenant', email: 'user@test.com', purpose: 'tenant_login' },
            config.platformSharedSecret,
            { expiresIn: '5m' }
        );
        const authController = require('../src/controllers/authController');
        const req = { body: { token: wrongTenantToken } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await authController.platformCallback(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringMatching(/different tenant/i) }));
    });

    it('returns 403 with code TENANT_SUSPENDED when tenant is suspended', async () => {
        if (!config.platformSharedSecret || !config.tenantId) return;
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({ status: 'suspended' });
        const User = require('../src/models/User');
        const fakeUser = { _id: '507f1f77bcf86cd799439099', email: 'suspended@test.com', name: 'U', isActive: true, role: 'admin', assignedLocationIds: [], defaultLocationId: null, tenantId: config.tenantId };
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(fakeUser);
        try {
            const token = jwt.sign(
                { tenantId: config.tenantId, email: 'suspended@test.com', purpose: 'tenant_login' },
                config.platformSharedSecret,
                { expiresIn: '5m' }
            );
            const authController = require('../src/controllers/authController');
            const req = { body: { token } };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await authController.platformCallback(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'TENANT_SUSPENDED' }));
        } finally {
            getEntitlementsSpy.mockRestore();
            findOneSpy.mockRestore();
        }
    });

    it('returns 404 when user does not exist', async () => {
        if (!config.platformSharedSecret || !config.tenantId) return;
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({ status: 'active' });
        const User = require('../src/models/User');
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(null);
        try {
            const token = jwt.sign(
                { tenantId: config.tenantId, email: 'nonexistent@test.com', purpose: 'tenant_login' },
                config.platformSharedSecret,
                { expiresIn: '5m' }
            );
            const authController = require('../src/controllers/authController');
            const req = { body: { token } };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await authController.platformCallback(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringMatching(/not found/i) }));
        } finally {
            getEntitlementsSpy.mockRestore();
            findOneSpy.mockRestore();
        }
    });

    it('on success returns token and data (user shape consistent with login/getMe)', async () => {
        if (!config.platformSharedSecret || !config.tenantId) return;
        const platformEntitlementsCache = require('../src/services/platformEntitlementsCache');
        const getEntitlementsSpy = jest.spyOn(platformEntitlementsCache, 'getEntitlements').mockResolvedValue({ status: 'active' });
        const User = require('../src/models/User');
        const fakeUser = {
            _id: '507f1f77bcf86cd799439098',
            email: 'handoff@test.com',
            name: 'Handoff User',
            isActive: true,
            role: 'admin',
            assignedLocationIds: [],
            defaultLocationId: null,
            tenantId: config.tenantId,
            getSignedJwtToken: function () { return jwt.sign({ id: this._id, role: this.role }, config.jwtSecret, { expiresIn: '7d' }); }
        };
        const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue(fakeUser);
        const rbacService = require('../src/services/rbacService');
        const attachSpy = jest.spyOn(rbacService, 'attachPermissionKeys').mockResolvedValue(undefined);
        try {
            const token = jwt.sign(
                { tenantId: config.tenantId, email: 'handoff@test.com', purpose: 'tenant_login' },
                config.platformSharedSecret,
                { expiresIn: '5m' }
            );
            const authController = require('../src/controllers/authController');
            const req = { body: { token } };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            await authController.platformCallback(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(attachSpy).toHaveBeenCalled();
            const payload = res.json.mock.calls[0][0];
            expect(payload.success).toBe(true);
            expect(payload.token).toBeDefined();
            expect(typeof payload.token).toBe('string');
            expect(payload.data).toBeDefined();
            expect(payload.data).toMatchObject({ _id: fakeUser._id, name: fakeUser.name, email: fakeUser.email, role: 'admin', tenantId: expect.any(String) });
            expect(Array.isArray(payload.data.permissionKeys)).toBe(true);
        } finally {
            getEntitlementsSpy.mockRestore();
            findOneSpy.mockRestore();
            attachSpy.mockRestore();
        }
    });
});
