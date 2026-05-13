/**
 * Access control tests: requirePermission middleware, 403 logging, unauthorized API access.
 */

const { protect, requirePermission, requirePerm, requireAnyPerm } = require('../src/middleware/auth');
const rbacService = require('../src/services/rbacService');

describe('Access control middleware', () => {
    const mockReq = (user = null) => ({
        user,
        method: 'GET',
        originalUrl: '/api/sales',
        path: '/sales',
        headers: {},
        connection: { remoteAddress: '127.0.0.1' }
    });
    const mockRes = () => {
        const res = {};
        res.status = jest.fn(() => res);
        res.json = jest.fn(() => res);
        return res;
    };
    const next = jest.fn();

    beforeEach(() => {
        next.mockClear();
    });

    describe('requirePermission', () => {
        it('returns 401 when user is missing', async () => {
            const req = mockReq(null);
            const res = mockRes();
            const mw = requirePermission('sale.view');
            await mw(req, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });

        it('allows admin role to pass without checking permissions', async () => {
            const req = mockReq({ role: 'admin', permissionKeys: new Set() });
            const res = mockRes();
            const mw = requirePermission('sale.void');
            await mw(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('allows when user has at least one of the required permissions', async () => {
            const req = mockReq({ role: 'staff', permissionKeys: new Set(['sale.view']) });
            const res = mockRes();
            const mw = requirePermission('sale.view', 'sale.create');
            await mw(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('returns 403 when user has none of the required permissions', async () => {
            const req = mockReq({ role: 'staff', permissionKeys: new Set(['sale.view']) });
            const res = mockRes();
            const mw = requirePermission('sale.void', 'user.manage');
            await mw(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('requirePerm', () => {
        it('requires single permission', async () => {
            const req = mockReq({ role: 'staff', permissionKeys: new Set(['audit.view']) });
            const res = mockRes();
            const mw = requirePerm('audit.view');
            await mw(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('returns 403 when single permission missing', async () => {
            const req = mockReq({ role: 'staff', permissionKeys: new Set(['sale.view']) });
            const res = mockRes();
            const mw = requirePerm('audit.view');
            await mw(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    describe('requireAnyPerm', () => {
        it('allows when user has any of the permissions', async () => {
            const req = mockReq({ role: 'manager', permissionKeys: new Set(['refund.issue']) });
            const res = mockRes();
            const mw = requireAnyPerm(['return.create', 'refund.issue', 'sale.view']);
            await mw(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('returns 403 when user has none', async () => {
            const req = mockReq({ role: 'cashier', permissionKeys: new Set(['sale.view']) });
            const res = mockRes();
            const mw = requireAnyPerm(['user.manage', 'role.manage']);
            await mw(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });
});

describe('rbacService.can (default deny)', () => {
    it('denies when permission key is missing', () => {
        expect(rbacService.can({ permissionKeys: new Set(['sale.view']) }, 'sale.void')).toBe(false);
    });
    it('denies when user has no permissionKeys', () => {
        expect(rbacService.can({}, 'sale.view')).toBe(false);
    });
});
