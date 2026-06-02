/**
 * Per-user sales mode: User.preferredRetailModeEnabled + company default fallback.
 */

const User = require('../src/models/User');

describe('effective retail mode', () => {
    describe('User model', () => {
        it('has preferredRetailModeEnabled nullable boolean (null = use company default)', () => {
            const schema = User.schema.obj;
            expect(schema.preferredRetailModeEnabled).toBeDefined();
            expect(schema.preferredRetailModeEnabled.type).toBe(Boolean);
            expect(schema.preferredRetailModeEnabled.default).toBeNull();
        });
    });
});
