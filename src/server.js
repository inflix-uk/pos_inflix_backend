const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config();

const connectDB = require('./config/db');
const loadAllModels = require('./lib/loadAllModels');
const routes = require('./routes');

// Eagerly register every model schema so populate() can resolve refs on any
// tenant DB connection from the very first request — no lazy-loading races.
loadAllModels();
const errorHandler = require('./middleware/errorHandler');
const tenantResolver = require('./middleware/tenantResolver');
const { requestLoggerMiddleware, errorLoggerMiddleware, logsRouteHandler } = require('./lib/requestLogger');

// Connect to database
connectDB();

const app = express();

// Pretty print JSON responses
app.set('json spaces', 2);

// Gzip/Brotli compression — reduces JSON payload size ~70-80%
app.use(compression());

// Body parser (increase limit for large imports e.g. parcel import with thousands of rows)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security headers - configure to allow serving images
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Enable CORS with multiple origins support
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(o => o.trim()).filter(Boolean);
// Optional: allow any tenant frontend on this domain (e.g. https://gnr.inflix.uk when CORS_TENANT_DOMAIN=inflix.uk)
const corsTenantDomain = (process.env.CORS_TENANT_DOMAIN || '').trim().toLowerCase();
const isDev = process.env.NODE_ENV !== 'production';
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        try {
            const host = new URL(origin).hostname.toLowerCase();
            // In development, allow any localhost origin (e.g. http://localhost:3001 for tenant frontend)
            if (isDev && (host === 'localhost' || host === '127.0.0.1')) {
                return callback(null, true);
            }
            // Allow any subdomain of CORS_TENANT_DOMAIN (http or https, e.g. gnr.inflix.uk)
            if (corsTenantDomain && (host === corsTenantDomain || host.endsWith('.' + corsTenantDomain))) {
                return callback(null, true);
            }
        } catch (_) { /* ignore */ }
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// Logging
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Welcome page
app.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Welcome to POS Inflix API',
        version: '1.0.0',
        documentation: '/api',
        health: '/health'
    });
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'POS Inflix API is running',
        timestamp: new Date().toISOString()
    });
});

// Debug: show which tenant DB is resolved for this request
app.get('/api/debug/tenant', async (req, res) => {
    const mongoose = require('mongoose');
    const tenantContext = require('./lib/tenantContext');
    const store = tenantContext.getStore();
    const tenantDb = (store && store.tenantDb) ? store.tenantDb : mongoose.connection;
    const dbName = tenantDb.name || tenantDb.db?.databaseName || '-';

    let userEmails = [];
    try {
        const users = await tenantDb.collection('users').find({}, { projection: { email: 1, role: 1, tenantId: 1 } }).limit(20).toArray();
        userEmails = users.map(u => ({ email: u.email, role: u.role, tenantId: u.tenantId }));
    } catch (e) {
        userEmails = [{ error: e.message }];
    }

    res.json({
        success: true,
        hostname: req.hostname,
        resolvedTenantId: req.tenantId || '-',
        database: dbName,
        defaultDb: mongoose.connection.name || mongoose.connection.db?.databaseName || '-',
        users: userEmails,
    });
});

// Diagnostic: confirm every model schema is registered in the per-tenant registry
// AND on the resolved tenant DB. Use this when debugging populate-returns-raw-id
// issues — it tells you instantly if the registry is missing a schema or if the
// tenant DB is missing one.
app.get('/api/debug/models', (req, res) => {
    const mongoose = require('mongoose');
    const tenantContext = require('./lib/tenantContext');
    const { getRegisteredModelNames } = require('./lib/tenantModel');
    const registry = getRegisteredModelNames();
    const store = tenantContext.getStore();
    const tenantDb = (store && store.tenantDb) ? store.tenantDb : mongoose.connection;
    const dbName = tenantDb.name || tenantDb.db?.databaseName || '-';
    const onTenantDb = Object.keys(tenantDb.models || {}).sort();
    const missingFromTenant = registry.filter((n) => !onTenantDb.includes(n));
    res.json({
        success: true,
        database: dbName,
        registryCount: registry.length,
        tenantDbCount: onTenantDb.length,
        registry,
        onTenantDb,
        missingFromTenantDb: missingFromTenant,
        allOk: missingFromTenant.length === 0,
    });
});

// Resolve tenant from hostname (subdomain → DB) before any route handler
app.set('trust proxy', true);
app.use(tenantResolver);

// Ensure caches differentiate responses per tenant (Origin determines the tenant)
app.use((req, res, next) => {
    res.set('Vary', 'Origin');
    res.set('Cache-Control', 'no-store');
    next();
});

// Log every request (route hit, status, duration, tenant, errors)
app.use(requestLoggerMiddleware);

// API routes
app.use('/api', routes);

// View logs: GET /api/logs?level=ERROR&limit=50
app.get('/api/logs', logsRouteHandler);

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Log errors to file & buffer before sending response
app.use(errorLoggerMiddleware);

// Error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const HOST = process.env.HOST || 'localhost';

const server = app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode`);
    console.log(`URL: http://${HOST}:${PORT}`);
    // Probe Redis cache so the boot log shows whether the shared cache is live
    // or we're falling back to the in-process memory cache.
    (async () => {
        const url = process.env.REDIS_URL;
        if (!url) {
            console.log('Redis: NOT CONFIGURED (REDIS_URL unset) → using in-memory cache fallback');
            return;
        }
        const safeUrl = url.replace(/\/\/[^@]+@/, '//***@');
        try {
            const Redis = require('ioredis');
            const probe = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000 });
            await probe.connect();
            const pong = await probe.ping();
            const info = await probe.info('server');
            const version = (info.match(/redis_version:([^\r\n]+)/) || [])[1] || 'unknown';
            console.log(`Redis: CONNECTED (${pong}) | version ${version} | url ${safeUrl}`);
            await probe.quit();
        } catch (e) {
            console.warn(`Redis: CONNECT FAILED (${e.message}) → using in-memory cache fallback | url ${safeUrl}`);
        }
    })();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.log(`Error: ${err.message}`);
    server.close(() => process.exit(1));
});

module.exports = app;
