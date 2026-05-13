const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { protectCustomerPortal } = require('../middleware/customerPortalAuth');
const {
    setPassword,
    login,
    getMe,
    getStatement,
    getInvoices,
    getInvoicePrintData,
    featureStatus
} = require('../controllers/customerPortalController');

// Admin action: set portal password for a customer (requires staff auth)
router.post('/set-password', protect, requirePermission('customer.edit'), setPassword);

// Public: customer portal login
router.post('/login', login);

// Public: check if customer invoicing feature is enabled
router.get('/feature-status', featureStatus);

// Customer portal protected routes
router.get('/me', protectCustomerPortal, getMe);
router.get('/statement', protectCustomerPortal, getStatement);
router.get('/invoices', protectCustomerPortal, getInvoices);
router.get('/invoices/:id/print-data', protectCustomerPortal, getInvoicePrintData);

module.exports = router;
