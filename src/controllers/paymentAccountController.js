/**
 * Payment accounts (pots) and money transfer.
 */
const mongoose = require('mongoose');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const PaymentAccount = require('../models/PaymentAccount');
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const paymentAccountService = require('../services/paymentAccountService');
const redis = require('../lib/redis');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const PAYMENT_ACCOUNT_CACHE_NAMESPACES = ['paymentAccounts:list'];
async function invalidatePaymentAccountCaches(tenantId) {
  await cache.bumpMany(PAYMENT_ACCOUNT_CACHE_NAMESPACES, tenantId);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * GET /api/accounts/payment-accounts
 * Query: locationId (optional). Returns active accounts with current balance.
 */
exports.getPaymentAccounts = asyncHandler(async (req, res) => {
  const tenantId = getTenantIdFromReq(req);
  const locationIdParam = req.query.locationId ? String(req.query.locationId).trim() : null;
  const userScope = getUserLocationScope(req.user);

  // 403 check must remain outside the cached fetcher (depends on user scope vs requested location).
  if (locationIdParam && userScope && userScope.length > 0 && !userScope.includes(locationIdParam)) {
    return res.status(403).json({ success: false, message: 'Not allowed to view this location' });
  }

  const params = {
    locationId: locationIdParam,
    scope: Array.isArray(userScope) && userScope.length > 0 ? [...userScope].sort() : null,
  };

  const data = await cache.cached(
    { ns: 'paymentAccounts:list', tenantId, params, ttlSec: TTL.BALANCE },
    async () => {
      let query = { tenantId, isActive: true };
      if (locationIdParam) {
        query.$or = [{ locationId: null }, { locationId: new mongoose.Types.ObjectId(locationIdParam) }];
      } else if (userScope && userScope.length > 0) {
        query.$or = [{ locationId: null }, { locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }];
      }

      const accounts = await PaymentAccount.find(query).sort({ type: 1, name: 1 }).lean();
      const accountIds = accounts.map((a) => a._id);
      const balances = await paymentAccountService.getAccountBalances(tenantId, accountIds);

      return accounts.map((a) => {
        const sid = a._id.toString();
        const bal = balances[sid] || { in: 0, out: 0, balance: 0 };
        return {
          _id: sid,
          name: a.name,
          type: a.type,
          locationId: a.locationId ? a.locationId.toString() : null,
          balance: round2(bal.balance),
          in: round2(bal.in),
          out: round2(bal.out),
        };
      });
    }
  );

  res.status(200).json({ success: true, data });
});

/**
 * POST /api/accounts/money-transfer
 * Body: fromAccountId, toAccountId, amount, fee (optional), notes (optional)
 * Creates OUT from fromAccount, IN to toAccount (method: transfer). Fee can be deducted from amount or separate.
 */
exports.createMoneyTransfer = asyncHandler(async (req, res) => {
  const tenantId = getTenantIdFromReq(req);
  const { fromAccountId, toAccountId, amount, fee = 0, notes = '' } = req.body;

  if (!fromAccountId || !toAccountId || amount == null) {
    return res.status(400).json({ success: false, message: 'fromAccountId, toAccountId and amount are required' });
  }
  const transferAmount = round2(Number(amount));
  const feeAmount = round2(Number(fee) || 0);
  if (transferAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Amount must be positive' });
  }
  if (fromAccountId === toAccountId) {
    return res.status(400).json({ success: false, message: 'From and to account must be different' });
  }

  const fromAcc = await PaymentAccount.findOne({ _id: fromAccountId, tenantId, isActive: true }).lean();
  const toAcc = await PaymentAccount.findOne({ _id: toAccountId, tenantId, isActive: true }).lean();
  if (!fromAcc) return res.status(404).json({ success: false, message: 'From account not found' });
  if (!toAcc) return res.status(404).json({ success: false, message: 'To account not found' });

  const balances = await paymentAccountService.getAccountBalances(tenantId, [fromAccountId]);
  const fromBalance = (balances[fromAccountId.toString()] || {}).balance || 0;
  const totalOut = round2(transferAmount + feeAmount);
  if (fromBalance < totalOut) {
    return res.status(400).json({ success: false, message: `Insufficient balance in ${fromAcc.name}. Available: ${round2(fromBalance)}` });
  }

  const now = new Date();
  const transferId = new mongoose.Types.ObjectId();
  await PaymentLedgerEntry.insertMany([
    {
      tenantId,
      occurredAtUtc: now,
      accountId: fromAcc._id,
      method: 'transfer',
      direction: 'out',
      amount: totalOut,
      entityType: 'MoneyTransfer',
      entityId: transferId,
      locationId: fromAcc.locationId || undefined,
      createdByUserId: req.user?.id || undefined,
    },
    {
      tenantId,
      occurredAtUtc: now,
      accountId: toAcc._id,
      method: 'transfer',
      direction: 'in',
      amount: transferAmount,
      entityType: 'MoneyTransfer',
      entityId: transferId,
      locationId: toAcc.locationId || undefined,
      createdByUserId: req.user?.id || undefined,
    },
  ]);

  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});

  await invalidatePaymentAccountCaches(tenantId);

  res.status(201).json({
    success: true,
    message: 'Transfer completed',
    data: {
      transferId: transferId.toString(),
      fromAccountId: fromAcc._id.toString(),
      toAccountId: toAcc._id.toString(),
      amount: transferAmount,
      fee: feeAmount,
      notes: (notes || '').trim(),
    },
  });
});
