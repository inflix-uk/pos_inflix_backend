module.exports = {
    port: process.env.PORT || 5000,
    nodeEnv: process.env.NODE_ENV || 'development',
    jwtSecret: process.env.JWT_SECRET,
    jwtExpire: process.env.JWT_EXPIRE || '90d',
    platformJwtSecret: process.env.PLATFORM_JWT_SECRET || (process.env.JWT_SECRET ? process.env.JWT_SECRET + '_platform' : undefined),
    platformJwtExpire: process.env.PLATFORM_JWT_EXPIRE || process.env.JWT_EXPIRE || '90d',
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10,
    mongodbUri: process.env.MONGODB_URI,
    tenantDbPrefix: process.env.TENANT_DB_PREFIX || 'tenant_',
    // Platform (centralised entitlements + usage) — one POS instance per tenant
    platformBaseUrl: process.env.PLATFORM_BASE_URL || '',
    platformSharedSecret: process.env.PLATFORM_SHARED_SECRET || '',
    tenantId: process.env.TENANT_ID || 'default',
    tenantUrlDomain: process.env.TENANT_URL_DOMAIN || '',
    platformTimeoutMs: parseInt(process.env.PLATFORM_TIMEOUT_MS, 10) || 5000,
    platformEntitlementsCacheTtlSec: parseInt(process.env.PLATFORM_ENTITLEMENTS_CACHE_TTL_SEC, 10) || 60,
    platformEntitlementsMaxStaleSec: parseInt(process.env.PLATFORM_ENTITLEMENTS_MAX_STALE_SEC, 10) || 900
};
