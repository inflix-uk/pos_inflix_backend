const mongoose = require('mongoose');

const healthCheckSchema = new mongoose.Schema({
    method: { type: String, required: true },
    url: { type: String, required: true },
    status: { type: Number, required: true },
    duration: { type: Number, required: true },
    tenant: { type: String, default: '-' },
    user: { type: String, default: '-' },
    ip: { type: String, default: '-' },
    level: { type: String, enum: ['INFO', 'WARN', 'ERROR'], default: 'INFO' },
    error: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
}, {
    timestamps: false,
    collection: 'healthchecks'
});

healthCheckSchema.index({ timestamp: -1 });
healthCheckSchema.index({ url: 1, timestamp: -1 });
healthCheckSchema.index({ user: 1, timestamp: -1 });
healthCheckSchema.index({ status: 1, timestamp: -1 });
healthCheckSchema.index({ method: 1, url: 1 });
healthCheckSchema.index({ level: 1, timestamp: -1 });

module.exports = require('../lib/tenantModel')('HealthCheck', healthCheckSchema);
module.exports.healthCheckSchema = healthCheckSchema;
