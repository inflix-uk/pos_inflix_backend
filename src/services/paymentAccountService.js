/**
 * Payment account (pot) resolution and default seeding.
 */
const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount');
const Location = require('../models/Location');

/**
 * Get default payment account ID for a given type (and optionally location for cash_drawer).
 * @param {string} tenantId
 * @param {'cash_drawer'|'bank'|'card'|'receivable'} type
 * @param {ObjectId|null} locationId - for cash_drawer, prefer account for this location
 * @returns {Promise<ObjectId|null>}
 */
async function getDefaultPaymentAccountId(tenantId, type, locationId = null) {
  const query = { tenantId, isActive: true, type };
  if (type === 'cash_drawer' && locationId) {
    query.locationId = locationId;
  } else if (type === 'cash_drawer') {
    query.$or = [{ locationId: null }, { locationId: { $exists: false } }];
  }
  const acc = await PaymentAccount.findOne(query).select('_id').lean();
  return acc ? acc._id : null;
}

/**
 * Get all active payment accounts for tenant (optionally scoped by location for cash_drawer).
 */
async function getPaymentAccounts(tenantId, options = {}) {
  const { locationId = null, includeInactive = false } = options;
  const query = { tenantId };
  if (!includeInactive) query.isActive = true;
  if (locationId !== undefined && locationId !== null) {
    query.$or = [{ locationId: null }, { locationId }, { locationId: { $exists: false } }];
  }
  return PaymentAccount.find(query).sort({ type: 1, name: 1 }).lean();
}

/**
 * Get balances per account from payment ledger (sum of IN - OUT).
 * Used by money-transfer UI and takings.
 */
async function getAccountBalances(tenantId, accountIds, asOfUtc = new Date()) {
  if (!accountIds || accountIds.length === 0) return {};
  const ids = accountIds.map((id) => (id && id.toString ? mongoose.Types.ObjectId(id.toString()) : id));
  const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
  const docs = await PaymentLedgerEntry.aggregate([
    {
      $match: {
        tenantId,
        accountId: { $in: ids },
        occurredAtUtc: { $lte: asOfUtc },
      },
    },
    {
      $group: {
        _id: '$accountId',
        in: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] } },
        out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } },
      },
    },
    { $addFields: { balance: { $subtract: ['$in', '$out'] } } },
  ]);
  const map = {};
  for (const d of docs) {
    const id = d._id && d._id.toString();
    if (id) map[id] = { in: d.in, out: d.out, balance: d.balance };
  }
  for (const id of accountIds) {
    const sid = id == null ? null : (typeof id === 'string' ? id : id.toString());
    if (sid && !map[sid]) map[sid] = { in: 0, out: 0, balance: 0 };
  }
  return map;
}

/**
 * Seed default payment accounts for a tenant: Receivable, one Bank, one Card, and one Cash drawer per location.
 */
async function seedDefaultPaymentAccounts(tenantId) {
  const existing = await PaymentAccount.countDocuments({ tenantId });
  if (existing > 0) return { created: 0, message: 'Accounts already exist' };

  const locations = await Location.find({ tenantId }).select('_id name').lean();
  const toCreate = [];

  toCreate.push({
    tenantId,
    name: 'Accounts Receivable',
    type: 'receivable',
    locationId: null,
    isActive: true,
  });
  toCreate.push({
    tenantId,
    name: 'Main Bank',
    type: 'bank',
    locationId: null,
    isActive: true,
  });
  toCreate.push({
    tenantId,
    name: 'Card Terminal',
    type: 'card',
    locationId: null,
    isActive: true,
  });
  for (const loc of locations) {
    toCreate.push({
      tenantId,
      name: `${loc.name || 'Location'} Cash Drawer`,
      type: 'cash_drawer',
      locationId: loc._id,
      isActive: true,
    });
  }
  if (locations.length === 0) {
    toCreate.push({
      tenantId,
      name: 'Cash Drawer',
      type: 'cash_drawer',
      locationId: null,
      isActive: true,
    });
  }

  await PaymentAccount.insertMany(toCreate);
  return { created: toCreate.length };
}

module.exports = {
  getDefaultPaymentAccountId,
  getPaymentAccounts,
  getAccountBalances,
  seedDefaultPaymentAccounts,
};
