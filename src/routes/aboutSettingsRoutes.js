const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getAboutSettings,
    saveAboutSettings,
    updateAboutSettings,
    deleteAboutSettings,
    uploadLogo,
    removeLogo
} = require('../controllers/aboutSettingsController');

// Configure multer for logo upload (memory storage to convert to base64)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|svg|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    }
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, svg, webp)'));
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 2 * 1024 * 1024 // 2MB limit
    },
    fileFilter: fileFilter
});

// All routes require authentication
router.use(protect);

// Validation rules
const aboutSettingsValidation = [
    body('appTitle')
        .notEmpty()
        .withMessage('App title is required')
        .isLength({ max: 100 })
        .withMessage('App title cannot exceed 100 characters'),
    body('appName')
        .notEmpty()
        .withMessage('App name is required')
        .isLength({ max: 100 })
        .withMessage('App name cannot exceed 100 characters'),
    body('loginPageTitle')
        .optional()
        .isLength({ max: 100 })
        .withMessage('Login page title cannot exceed 100 characters'),
    body('companyAddress')
        .optional()
        .isLength({ max: 500 })
        .withMessage('Company address cannot exceed 500 characters'),
    body('orderPdfTitle')
        .optional()
        .isLength({ max: 100 })
        .withMessage('Order PDF title cannot exceed 100 characters'),
    body('invoicePdfTitle')
        .optional()
        .isLength({ max: 100 })
        .withMessage('Invoice PDF title cannot exceed 100 characters')
];

router.route('/')
    .get(requirePermission('settings.view'), getAboutSettings)
    .post(requirePermission('settings.edit'), aboutSettingsValidation, validate, saveAboutSettings)
    .put(requirePermission('settings.edit'), updateAboutSettings)
    .delete(requirePermission('user.manage'), deleteAboutSettings);

router.route('/logo')
    .post(requirePermission('settings.edit'), upload.single('logo'), uploadLogo)
    .delete(requirePermission('settings.edit'), removeLogo);

module.exports = router;
