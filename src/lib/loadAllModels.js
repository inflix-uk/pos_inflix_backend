/**
 * Eagerly require every file in src/models/ at server startup AND verify each
 * one registers a schema via tenantModel().
 *
 * Why two jobs:
 *   1. Loading guarantees every schema enters the per-tenant registry, so
 *      populate() can resolve refs from the very first request to a fresh
 *      tenant DB. (See lib/tenantModel.js for the registry.)
 *   2. Verifying catches a recurrence of the silent-populate-fail bug class.
 *      If a model file uses raw mongoose.model() instead of tenantModel(),
 *      the registry won't grow when we require it — we log a loud warning
 *      naming the file so it's caught at boot, not by user reports months later.
 */
const fs = require('fs');
const path = require('path');
const { getRegisteredModelNames } = require('./tenantModel');

function loadAllModels() {
    const modelsDir = path.join(__dirname, '..', 'models');
    const files = fs.readdirSync(modelsDir)
        .filter((f) => f.endsWith('.js') && f !== 'index.js');

    const loaded = [];
    const failed = [];
    const nonRegistering = [];

    for (const file of files) {
        const namesBefore = new Set(getRegisteredModelNames());
        try {
            require(path.join(modelsDir, file));
            const namesAfter = getRegisteredModelNames();
            loaded.push(file);
            // A file is suspicious only if it neither grew the registry nor
            // produced a model whose name matches the file name. Files that
            // were already loaded earlier in the boot chain (Node's module
            // cache returns the cached export, registration code doesn't
            // re-run) would otherwise be flagged as false positives.
            const grew = namesAfter.length > namesBefore.size;
            const expectedName = file.replace(/\.js$/, '');
            const alreadyRegistered = namesAfter.includes(expectedName);
            if (!grew && !alreadyRegistered) {
                nonRegistering.push(file);
            }
        } catch (err) {
            failed.push({ file, error: err.message });
        }
    }

    console.log(`[models] preloaded ${loaded.length} model file(s); registry now has ${getRegisteredModelNames().length} schema(s)`);
    if (failed.length) {
        console.warn(`[models] ${failed.length} file(s) failed to load:`);
        for (const f of failed) console.warn(`  - ${f.file}: ${f.error}`);
    }
    if (nonRegistering.length) {
        console.warn(`[models] WARNING: ${nonRegistering.length} file(s) loaded but did NOT register a schema via tenantModel():`);
        for (const f of nonRegistering) console.warn(`  - ${f}  (uses raw mongoose.model()? populate() to this model will silently return raw IDs on cold tenant DBs)`);
    }
}

module.exports = loadAllModels;
