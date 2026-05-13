const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getNotesTermsSettings,
    saveNotesTermsSettings,
    updateNotesTermsSettings,
    deleteNotesTermsSettings
} = require('../controllers/notesTermsSettingsController');

// All routes require authentication
router.use(protect);

// Validation rules
const notesTermsValidation = [
    body('deliveryAddress')
        .optional()
        .isLength({ max: 1000 })
        .withMessage('Delivery address cannot exceed 1000 characters'),
    body('purchaseTermsConditions')
        .optional()
        .isLength({ max: 5000 })
        .withMessage('Purchase terms cannot exceed 5000 characters'),
    body('pdfSalesTerms')
        .optional()
        .isLength({ max: 5000 })
        .withMessage('PDF sales terms cannot exceed 5000 characters'),
    body('receiptPrinterSalesTerms')
        .optional()
        .isLength({ max: 2000 })
        .withMessage('Receipt printer sales terms cannot exceed 2000 characters'),
    body('receiptPrinterRepairTerms')
        .optional()
        .isLength({ max: 2000 })
        .withMessage('Receipt printer repair terms cannot exceed 2000 characters'),
    body('paymentNote')
        .optional()
        .isLength({ max: 2000 })
        .withMessage('Payment note cannot exceed 2000 characters')
];

router.route('/')
    .get(requirePermission('settings.view'), getNotesTermsSettings)
    .post(requirePermission('settings.edit'), notesTermsValidation, validate, saveNotesTermsSettings)
    .put(requirePermission('settings.edit'), notesTermsValidation, validate, updateNotesTermsSettings)
    .delete(requirePermission('user.manage'), deleteNotesTermsSettings);

module.exports = router;
