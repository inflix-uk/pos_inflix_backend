const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getUsers,
    getUser,
    updateUser,
    deleteUser,
    resetUserPassword
} = require('../controllers/userController');

router.use(protect);
router.use(requirePermission('user.manage'));

// Validation rules
const updateUserValidation = [
    body('email').optional().isEmail().withMessage('Please enter a valid email'),
    body('role').optional().isIn(['admin', 'manager', 'cashier']).withMessage('Invalid role')
];

const resetPasswordValidation = [
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

// Routes
router.route('/')
    .get(getUsers);

router.route('/:id')
    .get(getUser)
    .put(updateUserValidation, validate, updateUser)
    .delete(deleteUser);

router.put('/:id/resetpassword', resetPasswordValidation, validate, resetUserPassword);

module.exports = router;
