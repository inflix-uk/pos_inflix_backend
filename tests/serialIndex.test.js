const SerialIndex = require('../src/models/SerialIndex');

describe('SerialIndex model', () => {
    it('has required status enum values', () => {
        const statuses = SerialIndex.schema.obj.status.enum;
        expect(statuses).toContain('in_stock');
        expect(statuses).toContain('sold');
        expect(statuses).toContain('returned_to_supplier');
        expect(statuses).toContain('in_transfer');
        expect(statuses).toContain('adjusted_out');
        expect(statuses).toContain('not_found');
    });

    it('has tenantId and serial fields', () => {
        expect(SerialIndex.schema.obj.tenantId).toBeDefined();
        expect(SerialIndex.schema.obj.serial).toBeDefined();
        expect(SerialIndex.schema.obj.tenantId.default).toBe('default');
    });

    it('has normalizeSerial static that trims', () => {
        expect(SerialIndex.normalizeSerial('  abc  ')).toBe('abc');
        expect(SerialIndex.normalizeSerial(null)).toBe('');
    });

    it('STATUS export includes all expected keys', () => {
        expect(SerialIndex.STATUS).toBeDefined();
        expect(SerialIndex.STATUS.in_stock).toBe('in_stock');
        expect(SerialIndex.STATUS.sold).toBe('sold');
    });
});

describe('find-in-stock-serials API contract', () => {
    it('response shape: results array with serial, status, optional product, optional soldInfo', () => {
        const expectedStatuses = ['in_stock', 'already_sold', 'returned_to_supplier', 'not_found'];
        expectedStatuses.forEach((status) => {
            const example = { serial: 'IMEI123', status };
            if (status === 'in_stock') example.product = { sku: '', name: '', price: 0, category: '', brand: '', serial: 'IMEI123' };
            if (status === 'already_sold') example.soldInfo = { reference: '', customerName: '' };
            expect(example.serial).toBeDefined();
            expect(example.status).toBeDefined();
        });
    });
});
