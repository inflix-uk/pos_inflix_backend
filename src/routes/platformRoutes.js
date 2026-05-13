const express = require('express');
const router = express.Router();
const { requirePlatformAuth } = require('../middleware/auth');
const featureCatalog = require('../controllers/platformFeatureCatalogController');
const limitCatalog = require('../controllers/platformLimitCatalogController');
const planCatalog = require('../controllers/platformPlanCatalogController');
const tenants = require('../controllers/platformTenantsController');
const platformAdminAccounts = require('../controllers/platformAdminAccountsController');

router.use(requirePlatformAuth);

// Platform admin accounts (owner console)
router.get('/admin-accounts', platformAdminAccounts.list);
router.post('/admin-accounts', platformAdminAccounts.create);
router.get('/admin-accounts/:id', platformAdminAccounts.getOne);
router.put('/admin-accounts/:id', platformAdminAccounts.update);
router.delete('/admin-accounts/:id', platformAdminAccounts.deleteOne);

// Feature catalog
router.get('/feature-catalog', featureCatalog.list);
router.post('/feature-catalog', featureCatalog.create);
router.put('/feature-catalog/:key', featureCatalog.update);

// Limit catalog
router.get('/limit-catalog', limitCatalog.list);
router.post('/limit-catalog', limitCatalog.create);
router.put('/limit-catalog/:key', limitCatalog.update);

// Plan catalog
router.get('/plan-catalog', planCatalog.list);
router.post('/plan-catalog', planCatalog.create);
router.put('/plan-catalog/:planKey', planCatalog.update);
router.delete('/plan-catalog/:planKey', planCatalog.deletePlan);

// Roles (for tenant user management UI)
router.get('/roles', tenants.listRoles);

// Tenants (more specific routes first)
router.get('/tenants', tenants.list);
router.post('/tenants', tenants.createTenant);
router.get('/tenants/:tenantId/subscription', tenants.getSubscription);
router.put('/tenants/:tenantId/subscription', tenants.updateSubscription);
router.get('/tenants/:tenantId/users', tenants.listTenantUsers);
router.post('/tenants/:tenantId/users', tenants.createTenantUser);
router.put('/tenants/:tenantId/users/:userId/reset-password', tenants.resetTenantUserPassword);
router.put('/tenants/:tenantId/users/:userId', tenants.updateTenantUser);
router.delete('/tenants/:tenantId/users/:userId', tenants.deleteTenantUser);
router.get('/tenants/:tenantId', tenants.getTenant);
router.put('/tenants/:tenantId', tenants.updateTenant);
router.delete('/tenants/:tenantId', tenants.deleteTenant);

module.exports = router;
