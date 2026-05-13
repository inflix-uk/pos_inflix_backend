const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getSuppliers,
    getSupplier,
    createSupplier,
    updateSupplier,
    deleteSupplier,
    getSupplierProducts
} = require('../controllers/supplierController');

// All routes require authentication
router.use(protect);

// Validation rules
const supplierValidation = [
    body('name').notEmpty().withMessage('Supplier name is required'),
    body('phone').notEmpty().withMessage('Phone number is required')
];

router.route('/')
    .get(requirePermission('purchase.view'), getSuppliers)
    .post(requirePermission('purchase.create'), supplierValidation, validate, createSupplier);

router.route('/:id')
    .get(requirePermission('purchase.view'), getSupplier)
    .put(requirePermission('purchase.edit'), updateSupplier)
    .delete(requirePermission('user.manage'), deleteSupplier);

router.get('/:id/products', requirePermission('purchase.view', 'product.view'), getSupplierProducts);

module.exports = router;
