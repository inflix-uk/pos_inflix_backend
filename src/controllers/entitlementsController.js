/**
 * Tenant-facing: current tenant's effective entitlements and usage (read-only).
 * When Platform is configured, proxies platform entitlements (source of truth); billing from local DB.
 * Used by /settings/billing and sidebar feature visibility.
 */
const { getTenantIdFromReq } = require('../middleware/auth');
const entitlementsService = require('../services/entitlementsService');
const platformEntitlementsCache = require('../services/platformEntitlementsCache');
const platformClient = require('../lib/platformClient');
const Tenant = require('../models/Tenant');
const TenantSubscription = require('../models/TenantSubscription');
const asyncHandler = require('../middleware/asyncHandler');

exports.getMyEntitlements = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    let entitlements;
    let usage;
    let subscriptionType = 'plan';
    let status = 'active';
    let billingAmount = null;
    let billingCycle = 'monthly';
    let currency = 'GBP';
    let billingEmail = '';
    let billingAddress = '';
    let startDate = null;
    let expireDate = null;
    if (platformClient.isPlatformConfigured()) {
        console.log('[getMyEntitlements] Using platform path (cached TTL 60s)');
        const data = await platformEntitlementsCache.getEntitlements();
        console.log('[getMyEntitlements] Platform data status:', data.status);
        entitlements = { planKey: data.planKey, enabledFeatures: data.enabledFeatures, limits: data.limits };
        usage = data.usage || {};
        subscriptionType = data.subscriptionType ?? 'plan';
        status = data.status ?? 'active';
        billingAmount = data.billingAmount ?? null;
        billingCycle = data.billingCycle ?? 'monthly';
        currency = data.currency ?? 'GBP';
        billingEmail = data.billingEmail ?? '';
        billingAddress = data.billingAddress ?? '';
        startDate = data.startDate ?? null;
        expireDate = data.expireDate ?? null;
    } else {
        console.log('[getMyEntitlements] Using local DB path');
        [entitlements, usage] = await Promise.all([
            entitlementsService.getEntitlements(tenantId),
            entitlementsService.getUsage(tenantId)
        ]);
        // First try Platform-synced collections (billing, subscription), fallback to legacy models
        const tenantContext = require('../lib/tenantContext');
        const store = tenantContext.getStore();
        const db = (store && store.tenantDb) ? store.tenantDb : require('mongoose').connection;
        const [syncedBilling, syncedSubscription] = await Promise.all([
            db.collection('billing').findOne({ tenantId }),
            db.collection('subscription').findOne({ tenantId })
        ]);
        console.log('[getMyEntitlements] syncedBilling status:', syncedBilling?.status, '| syncedSubscription found:', !!syncedSubscription);
        if (syncedSubscription) {
            // Use Platform-synced data
            subscriptionType = syncedSubscription.subscriptionType ?? 'plan';
            startDate = syncedSubscription.startDate ?? null;
            expireDate = syncedSubscription.expireDate ?? null;
        } else {
            // Fallback to legacy TenantSubscription model
            const subscription = await TenantSubscription.findOne({ tenantId }).select('subscriptionType startDate expireDate').lean();
            subscriptionType = subscription?.subscriptionType ?? 'plan';
            startDate = subscription?.startDate ?? null;
            expireDate = subscription?.expireDate ?? null;
        }
        if (syncedBilling) {
            // Use Platform-synced billing data
            status = syncedBilling.status ?? 'active';
            billingAmount = syncedBilling.billingAmount ?? null;
            billingCycle = syncedBilling.billingCycle ?? 'monthly';
            currency = syncedBilling.currency ?? 'GBP';
            billingEmail = syncedBilling.billingEmail ?? '';
            billingAddress = syncedBilling.billingAddress ?? '';
        } else {
            // Fallback to legacy Tenant model
            const tenant = await Tenant.findOne({ tenantId }).select('billingAmount billingCycle currency billingEmail billingAddress').lean();
            billingAmount = tenant?.billingAmount ?? null;
            billingCycle = tenant?.billingCycle ?? 'monthly';
            currency = tenant?.currency ?? 'GBP';
            billingEmail = tenant?.billingEmail ?? '';
            billingAddress = tenant?.billingAddress ?? '';
        }
    }
    const responseData = {
        subscriptionType,
        planKey: entitlements.planKey,
        enabledFeatures: entitlements.enabledFeatures,
        limits: entitlements.limits,
        usage,
        status,
        billingAmount,
        billingCycle,
        currency,
        billingEmail,
        billingAddress,
        startDate,
        expireDate
    };
    console.log('[getMyEntitlements] tenantId:', tenantId, '| status:', status, '| subscriptionType:', subscriptionType, '| planKey:', entitlements.planKey);
    console.log(`[getMyEntitlements][sales/invoice] tenantId=${tenantId} served={sales:${entitlements.enabledFeatures.sales}, invoices:${entitlements.enabledFeatures.invoices}} source=${platformClient.isPlatformConfigured() ? 'platform-cache' : 'local-db'}`);
    res.status(200).json({ success: true, data: responseData });
});
