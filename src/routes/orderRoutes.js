const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getOrders,
    getOrder,
    createOrder,
    cancelOrder,
    getOrderByNumber
} = require('../controllers/orderController');

// All routes require authentication
router.use(protect);

// Validation rules
const orderValidation = [
    body('items').isArray({ min: 1 }).withMessage('Order must have at least one item'),
    body('items.*.product').notEmpty().withMessage('Product ID is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('paidAmount').isNumeric().withMessage('Paid amount is required')
];

router.route('/')
    .get(requirePermission('sale.view'), getOrders)
    .post(requirePermission('sale.create'), orderValidation, validate, createOrder);

router.get('/number/:orderNumber', requirePermission('sale.view'), getOrderByNumber);

router.route('/:id')
    .get(requirePermission('sale.view'), getOrder);

router.put('/:id/cancel', requirePermission('sale.edit', 'sale.void'), cancelOrder);

module.exports = router;
