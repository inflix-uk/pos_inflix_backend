const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getEmailSettings,
    saveEmailSettings,
    updateEmailSettings,
    deleteEmailSettings,
    testEmailSettings
} = require('../controllers/emailSettingsController');

// All routes require authentication
router.use(protect);

// Validation rules
const emailSettingsValidation = [
    body('smtpHost')
        .notEmpty()
        .withMessage('SMTP host is required')
        .isLength({ max: 255 })
        .withMessage('SMTP host cannot exceed 255 characters'),
    body('smtpPort')
        .notEmpty()
        .withMessage('SMTP port is required')
        .isInt({ min: 1, max: 65535 })
        .withMessage('SMTP port must be between 1 and 65535'),
    body('smtpSecure')
        .optional()
        .isIn(['none', 'ssl', 'tls'])
        .withMessage('SMTP secure must be none, ssl, or tls'),
    body('smtpUsername')
        .notEmpty()
        .withMessage('SMTP username is required')
        .isLength({ max: 255 })
        .withMessage('SMTP username cannot exceed 255 characters'),
    body('smtpPassword')
        .notEmpty()
        .withMessage('SMTP password is required')
        .isLength({ max: 255 })
        .withMessage('SMTP password cannot exceed 255 characters'),
    body('fromEmail')
        .notEmpty()
        .withMessage('From email is required')
        .isEmail()
        .withMessage('Please enter a valid from email address')
        .isLength({ max: 255 })
        .withMessage('From email cannot exceed 255 characters'),
    body('fromName')
        .notEmpty()
        .withMessage('From name is required')
        .isLength({ max: 100 })
        .withMessage('From name cannot exceed 100 characters'),
    body('replyToEmail')
        .optional()
        .isEmail()
        .withMessage('Please enter a valid reply-to email address'),
    body('replyToName')
        .optional()
        .isLength({ max: 100 })
        .withMessage('Reply-to name cannot exceed 100 characters')
];

const testEmailValidation = [
    body('testEmail')
        .notEmpty()
        .withMessage('Test email address is required')
        .isEmail()
        .withMessage('Please enter a valid email address')
];

router.route('/')
    .get(requirePermission('settings.view'), getEmailSettings)
    .post(requirePermission('settings.edit'), emailSettingsValidation, validate, saveEmailSettings)
    .put(requirePermission('settings.edit'), updateEmailSettings)
    .delete(requirePermission('user.manage'), deleteEmailSettings);

router.route('/test')
    .post(requirePermission('settings.edit'), testEmailValidation, validate, testEmailSettings);

module.exports = router;
