const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const { getInventoryReport } = require('../controllers/reportController');
const { getSummary, getByLocation, getLegacyCount } = require('../controllers/reportsDashboardController');
const { getTakingsDashboard } = require('../controllers/takingsDashboardController');

// All routes require authentication and reports feature
router.use(protect);
router.use(requireFeature('reports'));

// Tenant-safe: Sale/Repair/Metric-based (New Reports UI uses these + GET /api/dashboard).
router.get('/dashboard/summary', requirePermission('report.view'), getSummary);
router.get('/dashboard/by-location', requirePermission('report.view'), getByLocation);
router.get('/dashboard/legacy-count', requirePermission('report.view'), getLegacyCount);
router.get('/takings-dashboard', requirePermission('report.view', 'report.zread'), getTakingsDashboard);
router.get('/inventory', requirePermission('report.view', 'stock.view'), getInventoryReport);

// DISABLED: Order model has no tenantId — would leak cross-tenant. Re-enable after adding tenantId to Order and patching handlers.
// router.get('/dashboard', requirePermission('report.view'), getDashboardStats);
// router.get('/top-products', requirePermission('sale.view', 'product.view'), getTopProducts);
// router.get('/sales', requirePermission('report.view'), getSalesReport);
// router.get('/payment-methods', requirePermission('report.view'), getPaymentMethodReport);
// router.get('/cashiers', requirePermission('report.view'), getCashierReport);

module.exports = router;
