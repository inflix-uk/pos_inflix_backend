/**
 * Rate limiting and lockout for login.
 * - Rate limit: max N requests per 15 min per IP (handled by express-rate-limit if used).
 * - Lockout: after MAX_FAILED attempts for same email, block for LOCKOUT_MS.
 * In-memory store; resets on process restart.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

const failedCountByEmail = new Map();
const lockoutUntilByEmail = new Map();

function isLockedOut(email) {
    const until = lockoutUntilByEmail.get(email);
    if (!until) return false;
    if (Date.now() < until) return true;
    lockoutUntilByEmail.delete(email);
    failedCountByEmail.delete(email);
    return false;
}

function recordFailedLogin(email) {
    const count = (failedCountByEmail.get(email) || 0) + 1;
    failedCountByEmail.set(email, count);
    if (count >= MAX_FAILED_ATTEMPTS) {
        lockoutUntilByEmail.set(email, Date.now() + LOCKOUT_MS);
    }
}

function clearFailedLogins(email) {
    failedCountByEmail.delete(email);
    lockoutUntilByEmail.delete(email);
}

function getRemainingLockoutMs(email) {
    const until = lockoutUntilByEmail.get(email);
    if (!until || Date.now() >= until) return 0;
    return until - Date.now();
}

module.exports = {
    isLockedOut,
    recordFailedLogin,
    clearFailedLogins,
    getRemainingLockoutMs,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_MS
};
