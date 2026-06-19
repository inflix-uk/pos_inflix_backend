const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getCustomers,
    getCustomer,
    getCustomerSummary,
    getOrCreateWalkInCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer,
    deleteRecentCustomers,
    updateLoyaltyPoints
} = require('../controllers/customerController');

// All routes require authentication
router.use(protect);

// Validation rules
const customerValidation = [
    body('name').notEmpty().withMessage('Customer name is required'),
    body('phone').notEmpty().withMessage('Phone number is required')
];

const loyaltyValidation = [
    body('points').isNumeric().withMessage('Points must be a number'),
    body('type').isIn(['add', 'redeem']).withMessage('Type must be add or redeem')
];

// Routes - permission-based
router.route('/')
    .get(requirePermission('customer.view'), getCustomers)
    .post(requirePermission('customer.create'), customerValidation, validate, createCustomer);

router.get('/walk-in', requirePermission('sale.create', 'settings.view'), getOrCreateWalkInCustomer);

router.delete('/recent', requirePermission('customer.view', 'customer.edit'), deleteRecentCustomers);

router.get('/:id/summary', requirePermission('customer.view'), getCustomerSummary);

router.route('/:id')
    .get(requirePermission('customer.view'), getCustomer)
    .put(requirePermission('customer.edit'), updateCustomer)
    .delete(requirePermission('user.manage'), deleteCustomer);

router.put('/:id/loyalty', requirePermission('customer.edit'), loyaltyValidation, validate, updateLoyaltyPoints);

module.exports = router;
