/**
 * Sales date access tests — staff without report.view see today only (Europe/London).
 */

const {
  canViewHistoricalSales,
  applySalesDateRestriction,
  isWithinTodayLondon,
  getTodayLondonBounds,
} = require('../src/utils/salesDateAccess');

describe('salesDateAccess', () => {
  describe('canViewHistoricalSales', () => {
    it('returns true for admin regardless of permissionKeys', () => {
      expect(canViewHistoricalSales({ role: 'admin' })).toBe(true);
    });

    it('returns true when user has report.view', () => {
      expect(
        canViewHistoricalSales({ role: 'manager', permissionKeys: new Set(['report.view']) })
      ).toBe(true);
    });

    it('returns false when user lacks report.view', () => {
      expect(
        canViewHistoricalSales({ role: 'staff', permissionKeys: new Set(['sale.view']) })
      ).toBe(false);
    });
  });

  describe('applySalesDateRestriction', () => {
    it('passes through from/to for users with report.view', () => {
      const from = new Date('2025-01-01T00:00:00.000Z');
      const to = new Date('2025-01-31T23:59:59.999Z');
      const result = applySalesDateRestriction(
        { role: 'manager', permissionKeys: new Set(['report.view']) },
        { from, to }
      );
      expect(result.restricted).toBe(false);
      expect(result.from).toBe(from);
      expect(result.to).toBe(to);
    });

    it('forces today London bounds for staff without report.view', () => {
      const from = new Date('2020-01-01T00:00:00.000Z');
      const to = new Date('2020-12-31T23:59:59.999Z');
      const result = applySalesDateRestriction(
        { role: 'staff', permissionKeys: new Set(['sale.view']) },
        { from, to }
      );
      expect(result.restricted).toBe(true);
      const today = getTodayLondonBounds();
      expect(result.from.getTime()).toBe(today.fromUtc.getTime());
      expect(result.to.getTime()).toBe(today.toUtc.getTime());
      expect(result.dateKey).toBe(today.dateKey);
    });
  });

  describe('isWithinTodayLondon', () => {
    it('returns true for a date within today London bounds', () => {
      const { fromUtc, toUtc } = getTodayLondonBounds();
      const mid = new Date((fromUtc.getTime() + toUtc.getTime()) / 2);
      expect(isWithinTodayLondon(mid)).toBe(true);
    });

    it('returns false for a date far in the past', () => {
      expect(isWithinTodayLondon(new Date('2000-01-01T12:00:00.000Z'))).toBe(false);
    });

    it('returns false for invalid dates', () => {
      expect(isWithinTodayLondon('not-a-date')).toBe(false);
    });
  });
});
