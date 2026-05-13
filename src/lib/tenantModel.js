/**
 * Drop-in replacement for mongoose.model() that routes queries
 * to the correct tenant database via AsyncLocalStorage.
 *
 * Usage (in model files):
 *   module.exports = require('../lib/tenantModel')('Product', productSchema);
 *
 * Controllers require the model as usual — no changes needed.
 * During a request the tenantResolver middleware sets the ALS store
 * with the tenant connection; the proxy intercepts all model method
 * calls and redirects them to the tenant-scoped model.
 */
const mongoose = require('mongoose');
const tenantContext = require('./tenantContext');

// Registry of every (modelName, schema) defined via tenantModel(). Used to
// eagerly register all schemas on a tenant connection the first time it's
// accessed — required so .populate('Foo') can resolve refs for models that
// haven't been individually touched on that tenant DB yet.
const _registeredSchemas = new Map(); // modelName -> schema
const _initializedTenantDbs = new WeakSet(); // tenantDb connections we've fully populated

function _registerAllSchemasOnTenantDb(tenantDb) {
    if (_initializedTenantDbs.has(tenantDb)) return;
    const registered = [];
    for (const [name, schema] of _registeredSchemas) {
        if (!tenantDb.models[name]) {
            tenantDb.model(name, schema);
            registered.push(name);
        }
    }
    _initializedTenantDbs.add(tenantDb);
    const dbName = tenantDb.name || tenantDb.db?.databaseName || '?';
    console.log(`[tenant-init] db=${dbName} registered ${registered.length}/${_registeredSchemas.size} schemas (first request to this tenant)`);
}

/** Returns a snapshot of the schema registry — used by /api/__diagnostic. */
function getRegisteredModelNames() {
    return Array.from(_registeredSchemas.keys()).sort();
}

function tenantModel(modelName, schema) {
    // Register schema on the default connection (useDb inherits from it)
    const defaultModel = mongoose.models[modelName] || mongoose.model(modelName, schema);
    _registeredSchemas.set(modelName, schema);

    function getTenantModel(tenantDb) {
        // Ensure ALL schemas are registered on this tenant DB so populate() can resolve any ref.
        _registerAllSchemasOnTenantDb(tenantDb);
        try {
            return tenantDb.model(modelName);
        } catch (_) {
            return tenantDb.model(modelName, schema);
        }
    }

    return new Proxy(defaultModel, {
        get(target, prop, receiver) {
            // Outside a request or no tenant context → use default connection
            const store = tenantContext.getStore();
            if (store && store.tenantDb) {
                const tenantMdl = getTenantModel(store.tenantDb);
                const val = tenantMdl[prop];
                return typeof val === 'function' ? val.bind(tenantMdl) : val;
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' && typeof prop === 'string' ? val.bind(target) : val;
        },

        construct(target, args) {
            const store = tenantContext.getStore();
            if (store && store.tenantDb) {
                const TenantMdl = getTenantModel(store.tenantDb);
                return new TenantMdl(...args);
            }
            return new target(...args);
        }
    });
}

module.exports = tenantModel;
module.exports.getRegisteredModelNames = getRegisteredModelNames;
