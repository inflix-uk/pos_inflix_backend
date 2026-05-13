/**
 * Phase 2: Subdomain-based tenant resolution.
 * - Tenant model has subdomain field
 * - resolveTenantFromHost middleware resolves tenant from host/subdomain
 * - getTenantIdFromReq prefers resolved tenant over user.tenantId
 * - protect middleware enforces mismatch protection (subdomain tenant must match user.tenantId)
 * - localhost/dev falls back to user.tenantId or 'default'
 */
const mongoose = require('mongoose');
const Tenant = require('../src/models/Tenant');
const User = require('../src/models/User');
const { resolveTenantFromHost, extractSubdomain } = require('../src/middleware/resolveTenant');
const { getTenantIdFromReq, protect } = require('../src/middleware/auth');
const jwt = require('jsonwebtoken');
const config = require('../src/config');

function mockRes() {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = function (code) {
        res.statusCode = code;
        return res;
    };
    res.json = function (data) {
        res.body = data;
        return res;
    };
    res.get = function (header) {
        return this.headers[header.toLowerCase()];
    };
    return res;
}

function mockReq(overrides = {}) {
    const req = {
        params: {},
        query: {},
        body: {},
        headers: {},
        get: function (header) {
            return this.headers[header.toLowerCase()] || this.headers[header];
        },
        ...overrides
    };
    return req;
}

describe('Phase 2: Subdomain tenant resolution', () => {
    beforeAll(async () => {
        if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('extractSubdomain', () => {
        it('extracts subdomain from host', () => {
            expect(extractSubdomain('gnr.inflix.uk')).toBe('gnr');
            expect(extractSubdomain('acme.inflix.uk')).toBe('acme');
            expect(extractSubdomain('test-tenant.example.com')).toBe('test-tenant');
        });
        it('returns null for localhost', () => {
            expect(extractSubdomain('localhost')).toBe(null);
            expect(extractSubdomain('localhost:5000')).toBe(null);
            expect(extractSubdomain('127.0.0.1')).toBe(null);
            expect(extractSubdomain('127.0.0.1:5000')).toBe(null);
        });
        it('returns null for IP addresses', () => {
            expect(extractSubdomain('192.168.1.1')).toBe(null);
            expect(extractSubdomain('10.0.0.1:5000')).toBe(null);
        });
        it('returns null for reserved subdomains', () => {
            expect(extractSubdomain('api.inflix.uk')).toBe(null);
            expect(extractSubdomain('www.inflix.uk')).toBe(null);
            expect(extractSubdomain('admin.inflix.uk')).toBe(null);
            expect(extractSubdomain('platform.inflix.uk')).toBe(null);
        });
        it('returns null for single domain (no subdomain)', () => {
            expect(extractSubdomain('inflix.uk')).toBe(null);
            expect(extractSubdomain('example.com')).toBe(null);
        });
        it('handles invalid subdomains', () => {
            expect(extractSubdomain('_invalid.inflix.uk')).toBe(null);
            expect(extractSubdomain('-invalid.inflix.uk')).toBe(null);
            expect(extractSubdomain('invalid-.inflix.uk')).toBe(null);
        });
    });

    describe('resolveTenantFromHost', () => {
        it('resolves tenant from valid subdomain', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-resolve-' + Date.now();
            const subdomain = 'test-' + Date.now();
            const tenant = await Tenant.create({
                tenantId: tid,
                subdomain: subdomain,
                name: 'Test Tenant',
                status: 'active'
            });
            const req = mockReq({ headers: { host: `${subdomain}.inflix.uk` } });
            const res = mockRes();
            let nextCalled = false;
            await resolveTenantFromHost(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            expect(req.resolvedTenant).toBeTruthy();
            expect(req.resolvedTenant.tenantId).toBe(tid);
            expect(req.resolvedTenant.subdomain).toBe(subdomain);
            await Tenant.deleteOne({ _id: tenant._id });
        });

        it('returns 404 for unknown subdomain', async () => {
            if (!process.env.MONGODB_URI) return;
            const req = mockReq({ headers: { host: 'unknown-tenant.inflix.uk' } });
            const res = mockRes();
            let nextCalled = false;
            await resolveTenantFromHost(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(false);
            expect(res.statusCode).toBe(404);
            expect(res.body.code).toBe('TENANT_NOT_FOUND');
        });

        it('returns 404 for suspended tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-suspended-' + Date.now();
            const subdomain = 'suspended-' + Date.now();
            const tenant = await Tenant.create({
                tenantId: tid,
                subdomain: subdomain,
                name: 'Suspended Tenant',
                status: 'suspended'
            });
            const req = mockReq({ headers: { host: `${subdomain}.inflix.uk` } });
            const res = mockRes();
            let nextCalled = false;
            await resolveTenantFromHost(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(false);
            expect(res.statusCode).toBe(404);
            await Tenant.deleteOne({ _id: tenant._id });
        });

        it('sets resolvedTenant to null for localhost (dev fallback)', async () => {
            if (!process.env.MONGODB_URI) return;
            const req = mockReq({ headers: { host: 'localhost:5000' } });
            const res = mockRes();
            let nextCalled = false;
            await resolveTenantFromHost(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            expect(req.resolvedTenant).toBe(null);
        });

        it('sets resolvedTenant to null for IP address (dev fallback)', async () => {
            if (!process.env.MONGODB_URI) return;
            const req = mockReq({ headers: { host: '127.0.0.1:5000' } });
            const res = mockRes();
            let nextCalled = false;
            await resolveTenantFromHost(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            expect(req.resolvedTenant).toBe(null);
        });
    });

    describe('getTenantIdFromReq with resolved tenant', () => {
        it('prefers resolved tenant over user.tenantId', () => {
            const req = mockReq({
                resolvedTenant: { tenantId: 'resolved-tenant' },
                user: { tenantId: 'user-tenant' }
            });
            expect(getTenantIdFromReq(req)).toBe('resolved-tenant');
        });

        it('falls back to user.tenantId when no resolved tenant', () => {
            const req = mockReq({
                resolvedTenant: null,
                user: { tenantId: 'user-tenant' }
            });
            expect(getTenantIdFromReq(req)).toBe('user-tenant');
        });

        it('falls back to default when no resolved tenant and no user.tenantId', () => {
            const req = mockReq({
                resolvedTenant: null,
                user: {}
            });
            expect(getTenantIdFromReq(req)).toBe('default');
        });

        it('handles localhost/dev: resolvedTenant null, uses user.tenantId', () => {
            const req = mockReq({
                resolvedTenant: null,
                user: { tenantId: 'default' }
            });
            expect(getTenantIdFromReq(req)).toBe('default');
        });
    });

    describe('protect middleware mismatch protection', () => {
        it('allows access when user.tenantId matches resolved tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-match-' + Date.now();
            const user = await User.create({
                name: 'Test User',
                email: `match-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin',
                isActive: true
            });
            const token = jwt.sign({ id: user._id }, config.jwtSecret);
            const req = mockReq({
                headers: { authorization: `Bearer ${token}` },
                resolvedTenant: { tenantId: tid }
            });
            const res = mockRes();
            let nextCalled = false;
            await protect(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            await User.deleteOne({ _id: user._id });
        });

        it('denies access when user.tenantId does not match resolved tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-mismatch-' + Date.now();
            const user = await User.create({
                name: 'Test User',
                email: `mismatch-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: 'other-tenant',
                role: 'admin',
                isActive: true
            });
            const token = jwt.sign({ id: user._id }, config.jwtSecret);
            const req = mockReq({
                headers: { authorization: `Bearer ${token}` },
                resolvedTenant: { tenantId: tid }
            });
            const res = mockRes();
            let nextCalled = false;
            await protect(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(false);
            expect(res.statusCode).toBe(403);
            expect(res.body.code).toBe('TENANT_MISMATCH');
            await User.deleteOne({ _id: user._id });
        });

        it('allows access when resolvedTenant is null (localhost/dev)', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-localhost-' + Date.now();
            const user = await User.create({
                name: 'Test User',
                email: `localhost-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin',
                isActive: true
            });
            const token = jwt.sign({ id: user._id }, config.jwtSecret);
            const req = mockReq({
                headers: { authorization: `Bearer ${token}` },
                resolvedTenant: null
            });
            const res = mockRes();
            let nextCalled = false;
            await protect(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            await User.deleteOne({ _id: user._id });
        });

        it('allows access when user.tenantId is empty/null and resolved tenant exists (legacy user)', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase2-legacy-' + Date.now();
            const user = await User.create({
                name: 'Legacy User',
                email: `legacy-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: null,
                role: 'admin',
                isActive: true
            });
            const token = jwt.sign({ id: user._id }, config.jwtSecret);
            const req = mockReq({
                headers: { authorization: `Bearer ${token}` },
                resolvedTenant: { tenantId: tid }
            });
            const res = mockRes();
            let nextCalled = false;
            await protect(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            await User.deleteOne({ _id: user._id });
        });
    });
});
