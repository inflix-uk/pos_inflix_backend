const mongoose = require('mongoose');

/**
 * Daily aggregated metrics for tenant (summed across all locations) for fast dashboard.
 * Updated via $inc when Sale/SalesReturn/Repair events occur; dateKey is London YYYY-MM-DD.
 */
const tenantDailyMetricSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, default: 'default' },
  dateKey: { type: String, required: true }, // YYYY-MM-DD Europe/London

  salesRevenueGross: { type: Number, default: 0 },
  salesCount: { type: Number, default: 0 },
  returnsGross: { type: Number, default: 0 },
  returnsCount: { type: Number, default: 0 },

  repairsOpen: { type: Number, default: 0 },
  repairsOverdue: { type: Number, default: 0 },
  repairsReady: { type: Number, default: 0 },
  repairsCompleted: { type: Number, default: 0 },

  lowStockCount: { type: Number, default: 0 },
  outOfStockCount: { type: Number, default: 0 },

  createdAtUtc: { type: Date, default: Date.now },
  updatedAtUtc: { type: Date, default: Date.now },
}, { timestamps: false, collection: 'tenantdailymetrics' });

tenantDailyMetricSchema.index({ tenantId: 1, dateKey: 1 }, { unique: true });
tenantDailyMetricSchema.index({ tenantId: 1 });

module.exports = require('../lib/tenantModel')('TenantDailyMetric', tenantDailyMetricSchema);
