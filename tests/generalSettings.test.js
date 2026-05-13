/**
 * General settings: sales auto-select account (toggle + default account).
 * - Model fields
 * - Audit action/entity type for SETTINGS_UPDATED
 */

const GeneralSettings = require('../src/models/GeneralSettings');
const { AUDIT_ACTIONS, ENTITY_TYPES } = require('../src/models/AuditEvent');

describe('General Settings', () => {
    describe('GeneralSettings model', () => {
        it('has salesAutoSelectAccountEnabled with default false', () => {
            const schema = GeneralSettings.schema.obj;
            expect(schema.salesAutoSelectAccountEnabled).toBeDefined();
            expect(schema.salesAutoSelectAccountEnabled.default).toBe(false);
        });

        it('has defaultSalesAccountId nullable', () => {
            const schema = GeneralSettings.schema.obj;
            expect(schema.defaultSalesAccountId).toBeDefined();
            expect(schema.defaultSalesAccountId.default).toBeNull();
        });

        it('has retailModeEnabled with default false', () => {
            const schema = GeneralSettings.schema.obj;
            expect(schema.retailModeEnabled).toBeDefined();
            expect(schema.retailModeEnabled.default).toBe(false);
        });

        it('has updatedByUserId and timestamps', () => {
            const schema = GeneralSettings.schema.obj;
            expect(schema.updatedByUserId).toBeDefined();
            expect(GeneralSettings.schema.options.timestamps).toBe(true);
        });

        it('has getSettings static', () => {
            expect(typeof GeneralSettings.getSettings).toBe('function');
        });
    });

    describe('AuditEvent enum', () => {
        it('includes SETTINGS_UPDATED action', () => {
            expect(AUDIT_ACTIONS).toContain('SETTINGS_UPDATED');
        });

        it('includes Settings entity type', () => {
            expect(ENTITY_TYPES).toContain('Settings');
        });
    });
});
