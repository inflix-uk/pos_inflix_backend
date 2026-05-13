const { parseQrPayload, buildQrPayload, TYPES } = require('../src/utils/qrPayload');

describe('qrPayload', () => {
    describe('parseQrPayload', () => {
        it('parses POSv1|product|id', () => {
            const r = parseQrPayload('POSv1|product|abc123');
            expect(r).toEqual({ type: 'product', id: 'abc123' });
        });
        it('parses POSv1|serial|imei', () => {
            const r = parseQrPayload('POSv1|serial|351234567890123');
            expect(r).toEqual({ type: 'serial', id: '351234567890123' });
        });
        it('parses POSv1|location|id', () => {
            const r = parseQrPayload('POSv1|location|loc456');
            expect(r).toEqual({ type: 'location', id: 'loc456' });
        });
        it('parses legacy POS|product|id', () => {
            const r = parseQrPayload('POS|product|xyz');
            expect(r).toEqual({ type: 'product', id: 'xyz' });
        });
        it('returns null for empty or invalid', () => {
            expect(parseQrPayload('')).toBeNull();
            expect(parseQrPayload(null)).toBeNull();
            expect(parseQrPayload('invalid')).toBeNull();
            expect(parseQrPayload('POSv1|unknown|id')).toBeNull();
            expect(parseQrPayload('POSv1|product|')).toBeNull();
        });
        it('trims whitespace', () => {
            const r = parseQrPayload('  POSv1|product|id99  ');
            expect(r).toEqual({ type: 'product', id: 'id99' });
        });
    });

    describe('buildQrPayload', () => {
        it('builds product payload', () => {
            expect(buildQrPayload('product', 'abc')).toBe('POSv1|product|abc');
        });
        it('builds serial payload', () => {
            expect(buildQrPayload('serial', 'imei123')).toBe('POSv1|serial|imei123');
        });
        it('builds location payload', () => {
            expect(buildQrPayload('location', 'loc1')).toBe('POSv1|location|loc1');
        });
        it('returns empty string for invalid type or empty id', () => {
            expect(buildQrPayload('product', '')).toBe('');
            expect(buildQrPayload('invalid', 'id')).toBe('');
        });
    });

    it('TYPES includes product, serial, location', () => {
        expect(TYPES).toContain('product');
        expect(TYPES).toContain('serial');
        expect(TYPES).toContain('location');
    });
});
