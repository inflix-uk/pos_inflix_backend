const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getCoupons,
    getCoupon,
    getCouponByCode,
    validateCoupon,
    createCoupon,
    updateCoupon,
    deleteCoupon,
    useCoupon
} = require('../controllers/couponController');

// All routes require authentication
router.use(protect);

// Validation rules
const couponValidation = [
    body('name').notEmpty().withMessage('Coupon name is required'),
    body('code').notEmpty().withMessage('Coupon code is required'),
    body('type').isIn(['Percentage', 'Fixed Amount']).withMessage('Type must be Percentage or Fixed Amount'),
    body('discount').isNumeric().withMessage('Discount must be a number'),
    body('startDate').notEmpty().withMessage('Start date is required'),
    body('endDate').notEmpty().withMessage('End date is required')
];

const validateCouponValidation = [
    body('code').notEmpty().withMessage('Coupon code is required'),
    body('orderAmount').optional().isNumeric().withMessage('Order amount must be a number')
];

router.route('/')
    .get(requirePermission('sale.view'), getCoupons)
    .post(requirePermission('sale.view'), couponValidation, validate, createCoupon);

router.post('/validate', requirePermission('sale.view', 'sale.create'), validateCouponValidation, validate, validateCoupon);

router.get('/code/:code', requirePermission('sale.view'), getCouponByCode);

router.route('/:id')
    .get(requirePermission('sale.view'), getCoupon)
    .put(requirePermission('sale.edit'), updateCoupon)
    .delete(requirePermission('sale.void'), deleteCoupon);

router.put('/:id/use', requirePermission('sale.view', 'sale.create'), useCoupon);

module.exports = router;
