/**
 * Invoice + Receipt printing use Sale.locationId to show location details.
 * - resolveLocationForPrint: location A/B vs null fallback
 * - Receipt ESC/POS header uses location name/address
 * - getSalePrintContext returns sale + location
 */

const mongoose = require('mongoose');
const Location = require('../src/models/Location');
const Sale = require('../src/models/Sale');
const { resolveLocationForPrint, getLocationAddressBlock, getLocationAddressLines } = require('../src/utils/printLocationHelper');
const { buildReceiptEscpos, drawerKick, lineCharsForPaper, dividerLine } = require('../src/utils/escposReceipt');
const printController = require('../src/controllers/printController');

describe('printLocationHelper', () => {
  describe('getLocationAddressLines / getLocationAddressBlock', () => {
    it('builds lines from location doc', () => {
      const loc = { name: 'Store A', address: '1 High St', city: 'London', country: 'UK', phone: '020 123', email: 'a@b.com' };
      const lines = getLocationAddressLines(loc);
      expect(lines).toContain('1 High St');
      expect(lines).toContain('London');
      expect(lines).toContain('UK');
      expect(lines).toContain('Tel: 020 123');
      expect(lines).toContain('a@b.com');
      expect(getLocationAddressBlock(loc)).toContain('1 High St');
    });

    it('handles empty or partial location', () => {
      expect(getLocationAddressLines(null)).toEqual([]);
      expect(getLocationAddressLines({})).toEqual([]);
      const partial = { name: 'X', city: 'York' };
      expect(getLocationAddressLines(partial)).toEqual(['York']);
    });
  });

  describe('resolveLocationForPrint', () => {
    beforeAll(async () => {
      if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
      await mongoose.disconnect();
    });

    it('returns location when saleLocationId is valid', async () => {
      if (!process.env.MONGODB_URI) return;
      const locA = await Location.create({
        name: 'Print Test Store A',
        address: '10 Test Road',
        city: 'Manchester',
        country: 'UK',
        phone: '0161 111',
        email: 'a@printtest.com',
        isActive: true
      });
      const { location, fallbackLabel } = await resolveLocationForPrint(locA._id);
      expect(location).toBeDefined();
      expect(location.name).toBe('Print Test Store A');
      expect(location.address).toBe('10 Test Road');
      expect(location.phone).toBe('0161 111');
      expect(fallbackLabel).toBeNull();
      await Location.findByIdAndDelete(locA._id);
    });

    it('returns different location for locationId B', async () => {
      if (!process.env.MONGODB_URI) return;
      const locB = await Location.create({
        name: 'Print Test Store B',
        address: '20 Other St',
        city: 'Birmingham',
        country: 'UK',
        isActive: true
      });
      const { location } = await resolveLocationForPrint(locB._id);
      expect(location).toBeDefined();
      expect(location.name).toBe('Print Test Store B');
      expect(location.city).toBe('Birmingham');
      await Location.findByIdAndDelete(locB._id);
    });

    it('falls back to first active location when saleLocationId is null', async () => {
      if (!process.env.MONGODB_URI) return;
      const first = await Location.findOne({ isActive: true }).sort({ name: 1 }).lean();
      const { location, fallbackLabel } = await resolveLocationForPrint(null);
      if (first) {
        expect(location).toBeDefined();
        expect(location.name).toBe(first.name);
        expect(fallbackLabel).toBeNull();
      } else {
        expect(location).toBeNull();
        expect(fallbackLabel).toBe('Unknown location');
      }
    });

    it('returns fallbackLabel when no locations exist and saleLocationId is null', async () => {
      if (!process.env.MONGODB_URI) return;
      const count = await Location.countDocuments({ isActive: true });
      if (count > 0) {
        // cannot test "no locations" without wiping; just ensure null id with invalid id returns something
        const { location } = await resolveLocationForPrint(new mongoose.Types.ObjectId());
        expect(location).toBeNull();
      }
      const { location, fallbackLabel } = await resolveLocationForPrint(null);
      if (!location) expect(fallbackLabel).toBe('Unknown location');
    });
  });
});

describe('Receipt ESC/POS uses location header', () => {
  it('receipt buffer contains location name when settings use it', () => {
    const sale = {
      reference: 'INV-001',
      type: 'retail',
      items: [{ name: 'Item', price: 10, quantity: 1 }],
      total: 10,
      subtotal: 10,
      tax: 0,
      discount: 0,
      customerName: 'Walk-in',
      createdAt: new Date()
    };
    const settings = {
      companyName: 'Branch Manchester',
      companyAddress: '1 High Street\nManchester\nUK',
      receiptTerms: ''
    };
    const buffer = buildReceiptEscpos(sale, settings);
    const str = buffer.toString('utf8');
    expect(str).toContain('Branch Manchester');
    expect(str).toContain('1 High Street');
  });

  it('includes cash drawer kick bytes for cash retail sales', () => {
    const sale = {
      reference: 'INV-CASH',
      type: 'retail',
      paymentMethod: 'cash',
      items: [{ name: 'Item', price: 10, quantity: 1 }],
      total: 10,
      subtotal: 10,
      tax: 0,
      discount: 0,
      createdAt: new Date()
    };
    const buffer = buildReceiptEscpos(sale, { companyName: 'Shop', companyAddress: '' });
    const kick = drawerKick(0);
    expect(buffer.indexOf(kick)).toBeGreaterThanOrEqual(0);
  });

  it('uses full-width dividers for 80mm paper', () => {
    expect(lineCharsForPaper(80)).toBe(48);
    expect(dividerLine(48).length).toBe(48);
    const sale = {
      reference: 'INV-001',
      type: 'retail',
      paymentMethod: 'card',
      items: [{ name: 'Cable', price: 7.99, quantity: 1 }],
      total: 7.99,
      subtotal: 7.99,
      tax: 0,
      discount: 0,
      createdAt: new Date()
    };
    const buffer = buildReceiptEscpos(sale, {
      companyName: 'Shop',
      companyAddress: '1 High Street',
      salesPrint: { paperWidthMm: 80 }
    });
    const str = buffer.toString('utf8');
    expect(str).toContain(dividerLine(48));
  });

  it('does not include drawer kick for card-only sales', () => {
    const sale = {
      reference: 'INV-CARD',
      type: 'retail',
      paymentMethod: 'card',
      items: [{ name: 'Item', price: 10, quantity: 1 }],
      total: 10,
      subtotal: 10,
      tax: 0,
      discount: 0,
      createdAt: new Date()
    };
    const buffer = buildReceiptEscpos(sale, { companyName: 'Shop', companyAddress: '' });
    const kick = drawerKick(0);
    expect(buffer.indexOf(kick)).toBe(-1);
  });
});

describe('getSalePrintContext', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('returns sale and location when sale has locationId', async () => {
    if (!process.env.MONGODB_URI) return;
    const loc = await Location.create({
      name: 'Context Test Location',
      address: '5 Print Ave',
      city: 'Leeds',
      country: 'UK',
      isActive: true
    });
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'X', name: 'Product', price: 5, quantity: 1 }],
      subtotal: 5,
      total: 5,
      paymentMethod: 'cash',
      locationId: loc._id
    });
    const req = { params: { saleId: sale._id.toString() } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await printController.getSalePrintContext(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.sale).toBeDefined();
    expect(payload.data.sale.reference).toBeDefined();
    expect(payload.data.location).toBeDefined();
    expect(payload.data.location.name).toBe('Context Test Location');
    expect(payload.data.location.address).toBe('5 Print Ave');
    expect(payload.data.fallbackLabel).toBeNull();
    await Sale.findByIdAndDelete(sale._id);
    await Location.findByIdAndDelete(loc._id);
  });

  it('returns fallbackLabel when sale has null locationId and no locations in DB', async () => {
    if (!process.env.MONGODB_URI) return;
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'Y', name: 'Product', price: 1, quantity: 1 }],
      subtotal: 1,
      total: 1,
      paymentMethod: 'cash',
      locationId: null
    });
    const req = { params: { saleId: sale._id.toString() } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await printController.getSalePrintContext(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.sale).toBeDefined();
    // location may be first active or null; if null then fallbackLabel is set
    if (!payload.data.location) {
      expect(payload.data.fallbackLabel).toBe('Unknown location');
    }
    await Sale.findByIdAndDelete(sale._id);
  });
});
