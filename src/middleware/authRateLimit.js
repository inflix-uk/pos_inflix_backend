/**
 * Rate limit for auth endpoints (login, register) per IP.
 * Complements loginLimit.js (per-email lockout). Logs are in authController / activityLogService.
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_REQUESTS = 50; // per IP per window

const countByIp = new Map();
const windowStartByIp = new Map();

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

function authRateLimit(req, res, next) {
    const ip = getClientIp(req);   
    const now = Date.now();
    let start = windowStartByIp.get(ip);  
    if (!start || now - start > WINDOW_MS) {
        start = now;
        windowStartByIp.set(ip, start);
        countByIp.set(ip, 0);
    }
    const count = (countByIp.get(ip) || 0) + 1;
    countByIp.set(ip, count);

    if (count > MAX_REQUESTS) {
        return res.status(429).json({
            success: false,
            message: 'Too many attempts. Please try again later.'
        });
    }
    next();
}

module.exports = authRateLimit;
