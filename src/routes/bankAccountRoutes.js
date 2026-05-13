const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getBankAccounts,
    getBankAccount,
    createBankAccount,
    updateBankAccount,
    deleteBankAccount,
    setDefaultBankAccount
} = require('../controllers/bankAccountController');

// All routes require authentication
router.use(protect);

// Validation rules
const bankAccountValidation = [
    body('accountName')
        .notEmpty()
        .withMessage('Account name is required')
        .isLength({ max: 100 })
        .withMessage('Account name cannot exceed 100 characters'),
    body('bankName')
        .notEmpty()
        .withMessage('Bank name is required')
        .isLength({ max: 100 })
        .withMessage('Bank name cannot exceed 100 characters'),
    body('accountNumber')
        .notEmpty()
        .withMessage('Account number is required')
        .isLength({ max: 20 })
        .withMessage('Account number cannot exceed 20 characters'),
    body('sortCode')
        .notEmpty()
        .withMessage('Sort code is required')
        .matches(/^(\d{2}-\d{2}-\d{2}|\d{6})$/)
        .withMessage('Sort code must be in format XX-XX-XX or XXXXXX'),
    body('iban')
        .optional()
        .isLength({ max: 34 })
        .withMessage('IBAN cannot exceed 34 characters'),
    body('swiftBic')
        .optional()
        .isLength({ max: 11 })
        .withMessage('SWIFT/BIC cannot exceed 11 characters'),
    body('branchAddress')
        .optional()
        .isLength({ max: 500 })
        .withMessage('Branch address cannot exceed 500 characters')
];

router.route('/')
    .get(requirePermission('settings.view'), getBankAccounts)
    .post(requirePermission('settings.edit'), bankAccountValidation, validate, createBankAccount);

router.route('/:id')
    .get(requirePermission('settings.view'), getBankAccount)
    .put(requirePermission('settings.edit'), updateBankAccount)
    .delete(requirePermission('user.manage'), deleteBankAccount);

router.route('/:id/set-default')
    .put(requirePermission('settings.edit'), setDefaultBankAccount);

module.exports = router;
