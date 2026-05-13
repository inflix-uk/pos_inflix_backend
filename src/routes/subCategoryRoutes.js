const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getSubCategories,
    getSubCategory,
    createSubCategory,
    updateSubCategory,
    deleteSubCategory,
    getSubCategoriesByCategory
} = require('../controllers/subCategoryController');

// All routes require authentication
router.use(protect);

// Validation rules
const subCategoryValidation = [
    body('name').notEmpty().withMessage('Sub-category name is required'),
    body('category').notEmpty().withMessage('Category is required')
];

router.route('/')
    .get(requirePermission('product.view'), getSubCategories)
    .post(requirePermission('product.create'), subCategoryValidation, validate, createSubCategory);

router.route('/:id')
    .get(requirePermission('product.view'), getSubCategory)
    .put(requirePermission('product.edit'), updateSubCategory)
    .delete(requirePermission('product.delete'), deleteSubCategory);

router.get('/category/:categoryId', requirePermission('product.view'), getSubCategoriesByCategory);

module.exports = router;
