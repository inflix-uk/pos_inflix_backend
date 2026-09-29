/**
 * Run `fn` with a tenant's database as the active tenant context, for work that
 * happens outside an HTTP request (WhatsApp queue worker, WhatsApp socket callbacks).
 * Uses the same DB resolution as middleware/tenantResolver, so it reads and writes
 * exactly the database the tenant's own requests use. Without it, tenant models
 * fall back to the default connection.
 */
const mongoose = require('mongoose');
const config = require('../config');
const tenantContext = require('./tenantContext');

function runInTenant(tenantId, fn) {
    const dbName = (config.tenantDbPrefix || 'tenant_') + tenantId;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
    return tenantContext.run({ tenantDb, tenantId }, fn);
}

module.exports = runInTenant;
