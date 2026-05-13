#!/usr/bin/env node
/**
 * Seed default payment accounts (pots) for a tenant.
 * Usage: node src/scripts/seedPaymentAccounts.js [--tenant=default]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const paymentAccountService = require('../services/paymentAccountService');

const tenantId = process.argv.find((a) => a.startsWith('--tenant='))?.split('=')[1] || process.env.TENANT_ID || 'default';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/pos');
  const result = await paymentAccountService.seedDefaultPaymentAccounts(tenantId);
  console.log('Payment accounts seed:', result);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
