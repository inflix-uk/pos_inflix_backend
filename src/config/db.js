const mongoose = require('mongoose');
const config = require('./index');

// Hosted MongoDB load balancers periodically reap idle TCP connections, which
// surfaces as "Error: connection N to <host>:<port> closed". Without a listener
// these bubble up as unhandledRejection and crash the process — the driver
// itself reconnects fine, so we just log and let it recover.
function attachConnectionErrorListener(connection, label) {
    connection.on('error', (err) => {
        console.warn(`[mongo:${label}] connection error (auto-recovering): ${err.message}`);
    });
    connection.on('disconnected', () => {
        console.warn(`[mongo:${label}] disconnected — driver will retry`);
    });
    connection.on('reconnected', () => {
        console.log(`[mongo:${label}] reconnected`);
    });
}

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
    const originalUri = process.env.MONGODB_URI || process.env.MONGO_URI;

    if (!originalUri || typeof originalUri !== 'string') {
        console.error(
            'Error: MONGODB_URI is not set. Copy pos_inflix_backend/.env.example to .env and set your MongoDB connection string.'
        );
        process.exit(1);
    }

    try {
        const conn = await mongoose.connect(originalUri, {
            dbName: defaultDbName,
            serverSelectionTimeoutMS: 8000,
            // Recycle connections before the upstream LB silently kills them mid-flight.
            maxIdleTimeMS: 30000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000,
            maxPoolSize: 20,
            minPoolSize: 2,
            retryWrites: true,
            retryReads: true
        });
        attachConnectionErrorListener(conn.connection, 'default');
        console.log(`MongoDB Connected (default): ${conn.connection.host} | DB: ${defaultDbName}`);
    } catch (error) {
        const hasReplSetFlag = /[?&](replicaSet|directConnection)=/i.test(originalUri || '');
        if (hasReplSetFlag && isReplSetMismatchError(error)) {
            console.warn('[db] Replica set not reachable; retrying without replicaSet/directConnection options.');
            const fallbackUri = stripReplicaSetOptions(originalUri);
            try {
                const conn = await mongoose.connect(fallbackUri, {
                    dbName: defaultDbName,
                    serverSelectionTimeoutMS: 8000,
                    maxIdleTimeMS: 30000,
                    socketTimeoutMS: 45000,
                    heartbeatFrequencyMS: 10000,
                    maxPoolSize: 20,
                    minPoolSize: 2,
                    retryWrites: true,
                    retryReads: true
                });
                attachConnectionErrorListener(conn.connection, 'default');
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
