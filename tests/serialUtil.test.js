const { normalizeSerial } = require('../src/utils/serialUtil');

describe('serialUtil.normalizeSerial', () => {
    it('trims leading and trailing whitespace', () => {
        expect(normalizeSerial('  351234567890123  ')).toBe('351234567890123');
        expect(normalizeSerial('\tIMEI123\n')).toBe('IMEI123');
    });

    it('collapses multiple spaces to one', () => {
        expect(normalizeSerial('35  12  34')).toBe('35 12 34');
    });

    it('returns empty string for null and undefined', () => {
        expect(normalizeSerial(null)).toBe('');
        expect(normalizeSerial(undefined)).toBe('');
    });

    it('converts non-string to string and trims', () => {
        expect(normalizeSerial(12345)).toBe('12345');
    });

    it('matches existing stock adjustment/transfer normalization (trim only for compatibility)', () => {
        expect(normalizeSerial('ABC123')).toBe('ABC123');
        expect(normalizeSerial('  single  ')).toBe('single');
    });
});
