const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    listUsers,
    getUser,
    createUser,
    updateUser,
    resetUserPassword,
    deleteUser,
    listRoles,
    getRole,
    createRole,
    updateRole,
    deleteRole,
    getRolePermissions,
    saveRolePermissions,
    listPermissions
} = require('../controllers/adminController');

router.use(protect);

// Permissions list: anyone with role.manage or user.manage can see (for assign UI)
router.get('/permissions', requirePermission('role.manage', 'user.manage', 'audit.view'), listPermissions);

// Users (user.manage)
router.get('/users', requirePermission('user.manage'), listUsers);
router.get('/users/:id', requirePermission('user.manage'), getUser);
router.post('/users', requirePermission('user.manage'), [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password at least 8 characters')
], validate, createUser);
router.put('/users/:id', requirePermission('user.manage'), updateUser);
router.put('/users/:id/reset-password', requirePermission('user.manage'), [
    body('newPassword').isLength({ min: 8 }).withMessage('Password at least 8 characters')
], validate, resetUserPassword);
router.delete('/users/:id', requirePermission('user.manage'), deleteUser);

// Roles (role.manage)
router.get('/roles', requirePermission('role.manage'), listRoles);
router.get('/roles/:id', requirePermission('role.manage'), getRole);
router.post('/roles', requirePermission('role.manage'), [
    body('name').notEmpty().withMessage('Role name required')
], validate, createRole);
router.put('/roles/:id', requirePermission('role.manage'), updateRole);
router.delete('/roles/:id', requirePermission('role.manage'), deleteRole);
router.get('/roles/:id/permissions', requirePermission('role.manage'), getRolePermissions);
router.put('/roles/:id/permissions', requirePermission('role.manage'), [
    body('permissionKeys').isArray().withMessage('permissionKeys array required')
], validate, saveRolePermissions);

module.exports = router;
