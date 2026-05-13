/**
 * Takings Dashboard API tests.
 * - Default date range returns today (London) summary
 * - Location filter scopes response (location object)
 * - Payment breakdown shape: cash/card/bank/credit with in, out, net
 */

const mongoose = require('mongoose');
const { getLondonDateKey } = require('../src/utils/dateKey');

describe('Takings Dashboard', () => {
  describe('dateKey default (Europe/London)', () => {
    it('getLondonDateKey returns YYYY-MM-DD for today', () => {
      const key = getLondonDateKey(new Date());
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const [y, m, d] = key.split('-').map(Number);
      expect(y).toBeGreaterThanOrEqual(2020);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(12);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(31);
    });
  });

  describe('GET /api/reports/takings-dashboard', () => {
    beforeAll(async () => {
      if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
      await mongoose.disconnect();
    });

    it('default date range returns today (London) in range', async () => {
      if (!process.env.MONGODB_URI) return;
      const controller = require('../src/controllers/takingsDashboardController');
      const today = getLondonDateKey(new Date());
      const req = {
        query: {},
        user: { role: 'admin', tenantId: 'default' },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller.getTakingsDashboard(req, res);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
      const data = res.json.mock.calls[0][0].data;
      expect(data.range).toBeDefined();
      expect(data.range.from).toBe(today);
      expect(data.range.to).toBe(today);
      expect(data.range.timezone).toBe('Europe/London');
    });

    it('with from/to returns same range in response', async () => {
      if (!process.env.MONGODB_URI) return;
      const controller = require('../src/controllers/takingsDashboardController');
      const req = {
        query: { from: '2025-01-01', to: '2025-01-31' },
        user: { role: 'admin', tenantId: 'default' },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller.getTakingsDashboard(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
      const data = res.json.mock.calls[0][0].data;
      expect(data.range.from).toBe('2025-01-01');
      expect(data.range.to).toBe('2025-01-31');
    });

    it('location filter returns location object', async () => {
      if (!process.env.MONGODB_URI) return;
      const controller = require('../src/controllers/takingsDashboardController');
      const req = {
        query: { from: '2025-01-01', to: '2025-01-01', locationId: 'all' },
        user: { role: 'admin', tenantId: 'default' },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller.getTakingsDashboard(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
      const data = res.json.mock.calls[0][0].data;
      expect(data.location).toBeDefined();
      expect(data.location.locationId).toBe('all');
      expect(data.location.name).toBeDefined();
    });

    it('takings and profitAndLoss shape with payment breakdown', async () => {
      if (!process.env.MONGODB_URI) return;
      const controller = require('../src/controllers/takingsDashboardController');
      const req = {
        query: { from: '2020-01-01', to: '2030-12-31', locationId: 'all' },
        user: { role: 'admin', tenantId: 'default' },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller.getTakingsDashboard(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.any(Object) }));
      const data = res.json.mock.calls[0][0].data;
      expect(data.takings).toBeDefined();
      expect(data.takings).toHaveProperty('salesCount');
      expect(data.takings).toHaveProperty('refundsCount');
      expect(data.takings).toHaveProperty('voidsCount');
      expect(data.takings).toHaveProperty('grossSales');
      expect(data.takings).toHaveProperty('refundsGross');
      expect(data.takings).toHaveProperty('netRevenue');
      expect(data.takings.paymentBreakdown).toBeDefined();
      const pb = data.takings.paymentBreakdown;
      for (const method of ['cash', 'card', 'bank', 'credit']) {
        expect(pb[method]).toBeDefined();
        expect(pb[method]).toHaveProperty('in');
        expect(pb[method]).toHaveProperty('out');
        expect(pb[method]).toHaveProperty('net');
        expect(typeof pb[method].in).toBe('number');
        expect(typeof pb[method].out).toBe('number');
        expect(typeof pb[method].net).toBe('number');
      }
      expect(data.profitAndLoss).toBeDefined();
      expect(data.profitAndLoss).toHaveProperty('revenue');
      expect(data.profitAndLoss).toHaveProperty('cogs');
      expect(data.profitAndLoss).toHaveProperty('grossProfit');
      expect(data.profitAndLoss).toHaveProperty('operatingExpenses');
      expect(data.profitAndLoss).toHaveProperty('netProfit');
      expect(data.takings.accountBreakdown).toBeDefined();
      expect(Array.isArray(data.takings.accountBreakdown)).toBe(true);
    });
  });
});
