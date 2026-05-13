const mongoose = require('mongoose');
const tenantContext = require('../lib/tenantContext');

let txSupportCache = null;

function isStandaloneError(err) {
    const msg = (err && err.message) || '';
    const code = err && err.code;
    return (
        code === 20 ||
        code === 40573 ||
        /Transaction numbers are only allowed on a replica set/i.test(msg) ||
        /replica set/i.test(msg) ||
        /not supported.*standalone/i.test(msg)
    );
}

async function runWithTransaction(callback) {
    const store = tenantContext.getStore();
    const conn = (store && store.tenantDb) ? store.tenantDb : mongoose.connection;

    if (txSupportCache === false) {
        return callback(null);
    }

    let session;
    try {
        session = await conn.startSession();
        session.startTransaction();
    } catch (err) {
        if (isStandaloneError(err)) {
            txSupportCache = false;
            console.warn('[transactionService] MongoDB is standalone — falling back to non-transactional writes.');
            return callback(null);
        }
        throw err;
    }

    try {
        const result = await callback(session);
        await session.commitTransaction();
        txSupportCache = true;
        return result;
    } catch (err) {
        try { await session.abortTransaction(); } catch (_) { /* noop */ }
        if (isStandaloneError(err)) {
            txSupportCache = false;
            console.warn('[transactionService] Transactions unsupported — retrying without a session.');
            return callback(null);
        }
        throw err;
    } finally {
        session.endSession();
    }
}

async function supportsTransactions() {
    try {
        const store = tenantContext.getStore();
        const conn = (store && store.tenantDb) ? store.tenantDb : mongoose.connection;
        const admin = conn.db.admin();
        const status = await admin.command({ replSetGetStatus: 1 }).catch(() => null);
        return status != null && status.ok === 1;
    } catch {
        return false;
    }
}

module.exports = {
    runWithTransaction,
    supportsTransactions
};
