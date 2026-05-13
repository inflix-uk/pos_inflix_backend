/**
 * RBAC and auth tests: permission helper, password policy, lockout.
 */

const mongoose = require('mongoose');
const rbacService = require('../src/services/rbacService');
const { validatePassword, MIN_LENGTH } = require('../src/utils/passwordPolicy');
const loginLimit = require('../src/middleware/loginLimit');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Permission = require('../src/models/Permission');

describe('RBAC', () => {
    describe('passwordPolicy', () => {
        it('rejects short password', () => {
            expect(validatePassword('Ab1!').valid).toBe(false);
            expect(validatePassword('short').valid).toBe(false);
        });
        it('rejects password without uppercase', () => {
            expect(validatePassword('alllower1!').valid).toBe(false);
        });
        it('rejects password without lowercase', () => {
            expect(validatePassword('ALLUPPER1!').valid).toBe(false);
        });
        it('rejects password without number', () => {
            expect(validatePassword('NoNumbers!').valid).toBe(false);
        });
        it('rejects password without special char', () => {
            expect(validatePassword('NoSpecial1').valid).toBe(false);
        });
        it('accepts valid password', () => {
            expect(validatePassword('ValidPass1!').valid).toBe(true);
            expect(validatePassword('Another99@').valid).toBe(true);
        });
        it('MIN_LENGTH is at least 8', () => {
            expect(MIN_LENGTH).toBeGreaterThanOrEqual(8);
        });
    });

    describe('can()', () => {
        it('returns false when user is null', () => {
            expect(rbacService.can(null, 'sale.view')).toBe(false);
        });
        it('returns false when user has no permissionKeys', () => {
            expect(rbacService.can({}, 'sale.view')).toBe(false);
            expect(rbacService.can({ permissionKeys: new Set() }, 'sale.view')).toBe(false);
        });
        it('returns true when user has permission', () => {
            expect(rbacService.can({ permissionKeys: new Set(['sale.view']) }, 'sale.view')).toBe(true);
            expect(rbacService.can({ permissionKeys: new Set(['sale.view', 'sale.create']) }, 'sale.create')).toBe(true);
        });
        it('returns false when user lacks permission', () => {
            expect(rbacService.can({ permissionKeys: new Set(['sale.view']) }, 'sale.void')).toBe(false);
        });
    });

    describe('loginLimit', () => {
        it('isLockedOut returns false for new email', () => {
            expect(loginLimit.isLockedOut('new@test.com')).toBe(false);
        });
        it('recordFailedLogin and lockout after MAX_FAILED_ATTEMPTS', () => {
            const email = 'lockout-test-' + Date.now() + '@test.com';
            for (let i = 0; i < loginLimit.MAX_FAILED_ATTEMPTS; i++) {
                loginLimit.recordFailedLogin(email);
            }
            expect(loginLimit.isLockedOut(email)).toBe(true);
            loginLimit.clearFailedLogins(email);
            expect(loginLimit.isLockedOut(email)).toBe(false);
        });
    });

    describe('RBAC models', () => {
        it('Permission model has key and group', () => {
            const schema = Permission.schema.obj;
            expect(schema.key).toBeDefined();
            expect(schema.group).toBeDefined();
        });
        it('Role model has name and permissions', () => {
            const schema = Role.schema.obj;
            expect(schema.name).toBeDefined();
            expect(schema.permissions).toBeDefined();
        });
        it('User model has roles array', () => {
            const schema = User.schema.obj;
            expect(schema.roles).toBeDefined();
            expect(Array.isArray(schema.roles)).toBe(true);
        });
    });
});
