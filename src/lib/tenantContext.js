/**
 * AsyncLocalStorage for per-request tenant context.
 * The tenantResolver middleware stores { tenantDb, tenantId } here
 * so model proxies can route queries to the correct tenant database.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
module.exports = new AsyncLocalStorage();
