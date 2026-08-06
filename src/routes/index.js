const express = require('express');
const router = express.Router();
const { protect, requireTenantActive } = require('../middleware/auth');
const { resolveTenantFromHost } = require('../middleware/resolveTenant');

const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const categoryRoutes = require('./categoryRoutes');
const subCategoryRoutes = require('./subCategoryRoutes');
const variantAttributeRoutes = require('./variantAttributeRoutes');
const locationRoutes = require('./locationRoutes');
const productRoutes = require('./productRoutes');
const customerRoutes = require('./customerRoutes');
const supplierRoutes = require('./supplierRoutes');
const orderRoutes = require('./orderRoutes');
const salesRoutes = require('./salesRoutes');
const invoiceRoutes = require('./invoiceRoutes');
const reportRoutes = require('./reportRoutes');
const uploadRoutes = require('./uploadRoutes');
const aboutSettingsRoutes = require('./aboutSettingsRoutes');
const notesTermsSettingsRoutes = require('./notesTermsSettingsRoutes');
const bankAccountRoutes = require('./bankAccountRoutes');
const emailSettingsRoutes = require('./emailSettingsRoutes');
const taxRoutes = require('./taxRoutes');
const inventorySettingsRoutes = require('./inventorySettingsRoutes');
const generalSettingsRoutes = require('./generalSettingsRoutes');
const printingSettingsRoutes = require('./printingSettingsRoutes');
const headerQuickActionsRoutes = require('./headerQuickActionsRoutes');
const notebookRoutes = require('./notebookRoutes');
const notesRoutes = require('./notesRoutes');
const purchaseRoutes = require('./purchaseRoutes');
const purchaseReturnRoutes = require('./purchaseReturnRoutes');
const accountsRoutes = require('./accountsRoutes');
const salesReturnRoutes = require('./salesReturnRoutes');
const couponRoutes = require('./couponRoutes');
const giftCardRoutes = require('./giftCardRoutes');
const activityLogRoutes = require('./activityLogRoutes');
const adminRoutes = require('./adminRoutes');
const repairRoutes = require('./repairRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const expenseCategoryRoutes = require('./expenseCategoryRoutes');
const expenseRoutes = require('./expenseRoutes');
const stockTransferRoutes = require('./stockTransferRoutes');
const stockAdjustmentRoutes = require('./stockAdjustmentRoutes');
const inventoryRoutes = require('./inventoryRoutes');
const labelsRoutes = require('./labelsRoutes');
const printRoutes = require('./printRoutes');
const platformRoutes = require('./platformRoutes');
const platformAuthRoutes = require('./platformAuthRoutes');
const platformConnectionRoutes = require('./platformConnectionRoutes');
const entitlementsRoutes = require('./entitlementsRoutes');
const pricingGroupRoutes = require('./pricingGroupRoutes');
const customerPortalRoutes = require('./customerPortalRoutes');

// API root route
router.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'POS Inflix API',
        endpoints: {
            auth: '/api/auth',
            users: '/api/users',
            categories: '/api/categories',
            subcategories: '/api/subcategories',
            variantAttributes: '/api/variant-attributes',
            locations: '/api/locations',
            products: '/api/products',
            customers: '/api/customers',
            suppliers: '/api/suppliers',
            orders: '/api/orders',
            sales: '/api/sales',
            invoices: '/api/invoices',
            reports: '/api/reports',
            settings: '/api/settings/about',
            notesTerms: '/api/settings/notes-terms',
            bankAccounts: '/api/settings/bank-accounts',
            email: '/api/settings/email',
            taxes: '/api/settings/taxes',
            inventory: '/api/settings/inventory',
            general: '/api/settings/general',
            purchases: '/api/purchases',
            purchaseReturns: '/api/purchase-returns',
            accounts: '/api/accounts',
            salesReturns: '/api/sales-returns',
            coupons: '/api/coupons',
            giftCards: '/api/gift-cards',
            activityLog: '/api/activity-log',
            admin: '/api/admin',
            dashboard: '/api/dashboard',
            expenseCategories: '/api/expense-categories',
            expenses: '/api/expenses',
            stockTransfers: '/api/stock-transfers',
            stockAdjustments: '/api/stock-adjustments',
            inventory: '/api/inventory',
            print: '/api/print',
            platform: '/api/platform',
            platformAuth: '/api/platform-auth',
            platformConnection: '/api/platform-connection',
            entitlements: '/api/entitlements'
        }
    });
});

// Phase 2: Resolve tenant from subdomain before protected routes.
// For auth/platform routes, resolveTenantFromHost runs but won't block if no subdomain (localhost/dev).
// For protected routes, resolved tenant is used by getTenantIdFromReq and mismatch protection.
router.use(resolveTenantFromHost);

// POLICY A (Strict): For all tenant routes (except auth and platform), require tenant not suspended.
// Runs protect then requireTenantActive so suspended tenants get 403 TENANT_SUSPENDED.
// /api/auth and /api/platform are excluded; platform admins bypass inside requireTenantActive.
function tenantActiveGate(req, res, next) {
    const p = (req.path || '').replace(/^\/+/, '');
    if (p === '' || p === 'auth' || p.startsWith('auth/')) return next();
    if (p === 'platform' || p.startsWith('platform/')) return next();
    if (p === 'platform-auth' || p.startsWith('platform-auth/')) return next();
    if (p === 'customer-portal' || p.startsWith('customer-portal/')) return next();
    protect(req, res, (err) => {
        if (err) return next(err);
        requireTenantActive(req, res, next);
    });
}
router.use(tenantActiveGate);

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/categories', categoryRoutes);
router.use('/subcategories', subCategoryRoutes);
router.use('/variant-attributes', variantAttributeRoutes);
router.use('/locations', locationRoutes);
router.use('/products', productRoutes);
router.use('/customers', customerRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/orders', orderRoutes);
router.use('/sales', salesRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/reports', reportRoutes);
router.use('/upload', uploadRoutes);
router.use('/settings/about', aboutSettingsRoutes);
router.use('/settings/notes-terms', notesTermsSettingsRoutes);
router.use('/settings/bank-accounts', bankAccountRoutes);
router.use('/settings/email', emailSettingsRoutes);
router.use('/settings/taxes', taxRoutes);
router.use('/settings/inventory', inventorySettingsRoutes);
router.use('/settings/general', generalSettingsRoutes);
router.use('/settings/my-sales-mode', require('./userSalesModeRoutes'));
router.use('/settings/printing', printingSettingsRoutes);
router.use('/settings/header-quick-actions', headerQuickActionsRoutes);
router.use('/notebooks', notebookRoutes);
router.use('/notes', notesRoutes);
router.use('/purchases', purchaseRoutes);
router.use('/purchase-returns', purchaseReturnRoutes);
router.use('/accounts', accountsRoutes);
router.use('/sales-returns', salesReturnRoutes);
router.use('/coupons', couponRoutes);
router.use('/gift-cards', giftCardRoutes);
router.use('/activity-log', activityLogRoutes);
router.use('/admin', adminRoutes);
router.use('/repairs', repairRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/expense-categories', expenseCategoryRoutes);
router.use('/expenses', expenseRoutes);
router.use('/stock-transfers', stockTransferRoutes);
router.use('/stock-adjustments', stockAdjustmentRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/labels', labelsRoutes);
router.use('/print', printRoutes);
router.use('/platform-auth', platformAuthRoutes);
router.use('/platform', platformRoutes);
router.use('/platform-connection', platformConnectionRoutes);
router.use('/entitlements', entitlementsRoutes);
router.use('/pricing-groups', pricingGroupRoutes);
router.use('/customer-portal', customerPortalRoutes);
router.use('/whatsapp', require('./whatsappRoutes'));

module.exports = router;
