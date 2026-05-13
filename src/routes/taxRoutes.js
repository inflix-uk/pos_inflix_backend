const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getTaxes,
    getTax,
    getActiveTaxes,
    createTax,
    updateTax,
    deleteTax,
    setDefaultTax
} = require('../controllers/taxController');

// All routes require authentication
router.use(protect);

// Validation rules
const taxValidation = [
    body('name')
        .notEmpty()
        .withMessage('Tax name is required')
        .isLength({ max: 100 })
        .withMessage('Tax name cannot exceed 100 characters'),
    body('rate')
        .notEmpty()
        .withMessage('Tax rate is required')
        .isFloat({ min: 0, max: 100 })
        .withMessage('Tax rate must be between 0 and 100'),
    body('type')
        .optional()
        .isIn(['percentage', 'fixed'])
        .withMessage('Tax type must be percentage or fixed'),
    body('code')
        .optional()
        .isLength({ max: 20 })
        .withMessage('Tax code cannot exceed 20 characters'),
    body('description')
        .optional()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
];

router.route('/')
    .get(requirePermission('settings.view'), getTaxes)
    .post(requirePermission('settings.edit'), taxValidation, validate, createTax);

router.route('/active')
    .get(requirePermission('settings.view', 'sale.create'), getActiveTaxes);

router.route('/:id')
    .get(requirePermission('settings.view'), getTax)
    .put(requirePermission('settings.edit'), updateTax)
    .delete(requirePermission('settings.edit'), deleteTax);

router.route('/:id/set-default')
    .put(requirePermission('settings.edit'), setDefaultTax);

module.exports = router;
