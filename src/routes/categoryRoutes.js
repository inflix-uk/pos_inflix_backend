const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getCategories,
    getCategory,
    getCategoryBySlug,
    getCategoryVariantAttributes,
    addCategoryVariantValue,
    addCategoryVariantValueModel,
    addCategoryVariantValueModelChild,
    addCategoryVariantValueAtPath,
    updateCategoryVariantValueAtPath,
    deleteCategoryVariantValueAtPath,
    createCategory,
    updateCategory,
    deleteCategory
} = require('../controllers/categoryController');

// All routes require authentication
router.use(protect);

// Validation rules
const categoryValidation = [
    body('name').notEmpty().withMessage('Category name is required')
];

// Routes - permission-based
router.route('/')
    .get(requirePermission('product.view'), getCategories)
    .post(requirePermission('product.create'), categoryValidation, validate, createCategory);

router.get('/slug/:slug', requirePermission('product.view'), getCategoryBySlug);

router.get('/:id/variant-attributes', requirePermission('product.view'), getCategoryVariantAttributes);
router.post(
    '/:id/variant-attributes/:attributeId/values',
    requirePermission('variant_attribute.create'),
    addCategoryVariantValue
);
router.post(
    '/:id/variant-attributes/:attributeId/values/add-at-path',
    requirePermission('variant_attribute.create'),
    addCategoryVariantValueAtPath
);
router.put(
    '/:id/variant-attributes/:attributeId/values/update-at-path',
    requirePermission('variant_attribute.create'),
    updateCategoryVariantValueAtPath
);
router.delete(
    '/:id/variant-attributes/:attributeId/values/delete-at-path',
    requirePermission('variant_attribute.create'),
    deleteCategoryVariantValueAtPath
);
router.post(
    '/:id/variant-attributes/:attributeId/values/:valueId/models',
    requirePermission('variant_attribute.create'),
    addCategoryVariantValueModel
);
router.post(
    '/:id/variant-attributes/:attributeId/values/:valueId/models/:modelId/children',
    requirePermission('variant_attribute.create'),
    addCategoryVariantValueModelChild
);

router.route('/:id')
    .get(requirePermission('product.view'), getCategory)
    .put(requirePermission('product.edit'), updateCategory)
    .delete(requirePermission('product.delete'), deleteCategory);

module.exports = router;
