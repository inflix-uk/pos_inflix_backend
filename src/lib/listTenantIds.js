/**
 * Every tenant id the server can serve: one per tenant database (`<tenantDbPrefix><tenantId>`),
 * plus any tenant registered on the platform. Requests resolve the tenant from the subdomain
 * alone, so the `tenants` collection is not a complete list (it is empty in production).
 * Waits for the default connection first, so it is safe to call straight after boot.
 */
const mongoose = require('mongoose');
const config = require('../config');
const Tenant = require('../models/Tenant');

function waitForConnection() {
    if (mongoose.connection.readyState === 1) return Promise.resolve();
    return new Promise((resolve) => mongoose.connection.once('connected', resolve));
}

async function listTenantIds() {
    await waitForConnection();
    const ids = new Set();
    const prefix = config.tenantDbPrefix || 'tenant_';
    try {
        const { databases } = await mongoose.connection.db.admin().listDatabases({ nameOnly: true });
        for (const { name } of databases) {
            if (name.startsWith(prefix) && name.length > prefix.length) ids.add(name.slice(prefix.length));
        }
    } catch (e) {
        console.warn(`[tenants] could not list tenant databases: ${e.message}`);
    }
    try {
        const tenants = await Tenant.find({}).select('tenantId').lean();
        for (const t of tenants) if (t.tenantId) ids.add(String(t.tenantId));
    } catch (e) {
        console.warn(`[tenants] could not read registered tenants: ${e.message}`);
    }
    return [...ids];
}

module.exports = listTenantIds;
