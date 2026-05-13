const mongoose = require('mongoose');
const config = require('./index');

function stripReplicaSetOptions(uri) {
    return uri
        .replace(/([?&])replicaSet=[^&]*&?/i, '$1')
        .replace(/([?&])directConnection=[^&]*&?/i, '$1')
        .replace(/[?&]$/, '');
}

function isReplSetMismatchError(err) {
    const msg = (err && err.message) || '';
    return (
        /no primary found/i.test(msg) ||
        /NoReplicationEnabled/i.test(msg) ||
        /not running with --replSet/i.test(msg) ||
        /ReplicaSetNoPrimary/i.test(msg) ||
        /server selection/i.test(msg)
    );
}

const connectDB = async () => {
    const defaultDbName = (config.tenantDbPrefix || 'tenant_') + (config.tenantId || 'default');
    const originalUri = process.env.MONGODB_URI;

    try {
        const conn = await mongoose.connect(originalUri, {
            dbName: defaultDbName,
            serverSelectionTimeoutMS: 8000
        });
        console.log(`MongoDB Connected (default): ${conn.connection.host} | DB: ${defaultDbName}`);
    } catch (error) {
        const hasReplSetFlag = /[?&](replicaSet|directConnection)=/i.test(originalUri || '');
        if (hasReplSetFlag && isReplSetMismatchError(error)) {
            console.warn('[db] Replica set not reachable; retrying without replicaSet/directConnection options.');
            const fallbackUri = stripReplicaSetOptions(originalUri);
            try {
                const conn = await mongoose.connect(fallbackUri, {
                    dbName: defaultDbName,
                    serverSelectionTimeoutMS: 8000
                });
                console.log(`MongoDB Connected (standalone fallback): ${conn.connection.host} | DB: ${defaultDbName}`);
                return;
            } catch (fallbackErr) {
                console.error(`Error (fallback): ${fallbackErr.message}`);
                process.exit(1);
            }
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }

    if (config.tenantUrlDomain) {
        console.log(`Multi-tenant mode: *.${config.tenantUrlDomain} → tenant_{subdomain}`);
    }
};

module.exports = connectDB;
