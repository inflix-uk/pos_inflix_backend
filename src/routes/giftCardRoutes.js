const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getGiftCards,
    getGiftCard,
    createGiftCard,
    updateGiftCard,
    deleteGiftCard,
    redeemGiftCard
} = require('../controllers/giftCardController');

// All routes require authentication
router.use(protect);

// Validation rules
const giftCardValidation = [
    body('customer.name').notEmpty().withMessage('Customer name is required'),
    body('amount').isNumeric().withMessage('Amount must be a number'),
    body('expiryDate').notEmpty().withMessage('Expiry date is required')
];

const redeemValidation = [
    body('amount').isNumeric().withMessage('Amount must be a number')
];

router.route('/')
    .get(requirePermission('sale.view'), getGiftCards)
    .post(requirePermission('sale.view', 'sale.create'), giftCardValidation, validate, createGiftCard);

router.route('/:id')
    .get(requirePermission('sale.view'), getGiftCard)
    .put(requirePermission('sale.edit'), updateGiftCard)
    .delete(requirePermission('sale.void'), deleteGiftCard);

router.put('/:id/redeem', requirePermission('sale.view', 'sale.create'), redeemValidation, validate, redeemGiftCard);

module.exports = router;
