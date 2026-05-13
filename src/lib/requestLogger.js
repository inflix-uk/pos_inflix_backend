/**
 * Request & Error Logger
 *
 * Logs every route hit and every error to:
 *   1. In-memory ring buffer — accessible via GET /api/logs (last 500 entries)
 *   2. A log file (logs/requests.log) — only when running locally (skipped on Vercel/serverless)
 *
 * Each log entry contains: timestamp, method, url, status, response time,
 * tenant, user, IP, error (if any).
 */

// --- In-memory ring buffer (last 500 entries) ---
const MAX_ENTRIES = 500;
const logBuffer = [];

function pushLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > MAX_ENTRIES) logBuffer.shift();
}

// --- File logging (local only, skip on serverless) ---
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
let fileStream = null;
let currentDateStr = '';

function writeToFile(entry) {
    if (isServerless) return; // no writable filesystem on serverless

    try {
        const fs = require('fs');
        const path = require('path');
        const logsDir = path.join(__dirname, '../../logs');
        const dateStr = new Date().toISOString().slice(0, 10);

        if (!fileStream || currentDateStr !== dateStr) {
            if (fileStream) { try { fileStream.end(); } catch (_) {} }
            try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
            currentDateStr = dateStr;
            fileStream = fs.createWriteStream(path.join(logsDir, `requests-${dateStr}.log`), { flags: 'a' });
        }

        fileStream.write(JSON.stringify(entry) + '\n');
    } catch (_) {
        // Silent fail — don't crash the server for logging
    }
}

// --- DB persistence (fire-and-forget) ---
const { healthCheckSchema } = require('../models/HealthCheck');

function writeToDb(req, entry, durationMs) {
    try {
        const tenantDb = req.tenantDb;
        if (!tenantDb) return;
        let HCModel;
        try { HCModel = tenantDb.model('HealthCheck'); } catch (_) {
            HCModel = tenantDb.model('HealthCheck', healthCheckSchema);
        }
        HCModel.create({
            method: entry.method,
            url: entry.url,
            status: entry.status,
            duration: durationMs,
            tenant: entry.tenant,
            user: entry.user,
            ip: entry.ip,
            level: entry.level,
            error: entry.error || '',
            userAgent: req.headers['user-agent'] || '',
            timestamp: new Date()
        }).catch(() => {}); // silent fail — never block requests for logging
    } catch (_) { /* silent */ }
}

// --- Middleware: request logger ---
function requestLoggerMiddleware(req, res, next) {
    const start = Date.now();

    // Capture the original end to log after response
    const originalEnd = res.end;
    res.end = function (...args) {
        const duration = Date.now() - start;
        const entry = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.originalUrl || req.url,
            status: res.statusCode,
            duration: `${duration}ms`,
            tenant: req.tenantId || '-',
            user: (req.user && req.user.email) || '-',
            ip: req.ip || req.connection?.remoteAddress || '-',
        };

        // Flag errors
        if (res.statusCode >= 400) {
            entry.level = res.statusCode >= 500 ? 'ERROR' : 'WARN';
        } else {
            entry.level = 'INFO';
        }

        pushLog(entry);
        writeToFile(entry);
        writeToDb(req, entry, duration);

        originalEnd.apply(res, args);
    };

    next();
}

// --- Middleware: error logger (use after routes, before errorHandler) ---
function errorLoggerMiddleware(err, req, res, next) {
    const entry = {
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        method: req.method,
        url: req.originalUrl || req.url,
        tenant: req.tenantId || '-',
        user: (req.user && req.user.email) || '-',
        ip: req.ip || req.connection?.remoteAddress || '-',
        error: err.message || String(err),
        stack: (err.stack || '').split('\n').slice(0, 5).join(' | '),
    };

    pushLog(entry);
    writeToFile(entry);

    next(err); // Pass to errorHandler
}

// --- Route handler: GET /api/logs ---
function logsRouteHandler(req, res) {
    const level = (req.query.level || '').toUpperCase(); // ?level=ERROR
    const limit = Math.min(parseInt(req.query.limit) || 100, MAX_ENTRIES);

    let results = [...logBuffer].reverse(); // newest first

    if (level) {
        results = results.filter(e => e.level === level);
    }

    results = results.slice(0, limit);

    res.json({
        success: true,
        count: results.length,
        total: logBuffer.length,
        logs: results,
    });
}

module.exports = {
    requestLoggerMiddleware,
    errorLoggerMiddleware,
    logsRouteHandler,
};
