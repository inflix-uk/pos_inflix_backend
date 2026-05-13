const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, optionalProtect, requireTenantActive } = require('../middleware/auth');
const authRateLimit = require('../middleware/authRateLimit');
const {
    register,
    login,
    getMe,
    platformCallback,
    updatePassword,
    logout
} = require('../controllers/authController');

// Validation rules
const { MIN_LENGTH } = require('../utils/passwordPolicy');
const registerValidation = [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please enter a valid email'),
    body('password').isLength({ min: MIN_LENGTH }).withMessage(`Password must be at least ${MIN_LENGTH} characters`)
];

const loginValidation = [
    body('email').isEmail().withMessage('Please enter a valid email'),
    body('password').notEmpty().withMessage('Password is required')
];

const updatePasswordValidation = [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: MIN_LENGTH }).withMessage(`New password must be at least ${MIN_LENGTH} characters`)
];

router.post('/register', authRateLimit, registerValidation, validate, register);
router.post('/login', authRateLimit, loginValidation, validate, login);
router.post('/platform-callback', platformCallback);
router.get('/me', protect, requireTenantActive, getMe);
router.put('/updatepassword', protect, updatePasswordValidation, validate, updatePassword);
router.post('/logout', protect, logout);

module.exports = router;
