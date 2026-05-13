const mongoose = require('mongoose');

/**
 * Daily aggregated metrics per location for fast dashboard at scale (100+ locations).
 * Updated via $inc on Sale/SalesReturn/Repair events; dateKey is London YYYY-MM-DD.
 */
const locationDailyMetricSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, default: 'default' },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
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
}, { timestamps: false, collection: 'locationdailymetrics' });

locationDailyMetricSchema.index({ tenantId: 1, locationId: 1, dateKey: 1 }, { unique: true });
locationDailyMetricSchema.index({ tenantId: 1, dateKey: 1 });

module.exports = require('../lib/tenantModel')('LocationDailyMetric', locationDailyMetricSchema);
