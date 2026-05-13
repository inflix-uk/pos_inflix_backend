const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getVariantAttributes,
    getVariantAttribute,
    getVariantAttributeBySlug,
    createVariantAttribute,
    updateVariantAttribute,
    deleteVariantAttribute,
    getActiveVariantAttributes,
    addVariantAttributeValue,
    addVariantAttributeValueModel,
    checkVariantValueUsage,
    replaceAndRemoveVariantValue
} = require('../controllers/variantAttributeController');

// All routes require authentication
router.use(protect);

// Validation rules for variant attributes
const variantValidation = [
    body('name').notEmpty().withMessage('Name is required')
];

router.get('/active', requirePermission('product.view'), getActiveVariantAttributes);
router.get('/slug/:slug', requirePermission('product.view'), getVariantAttributeBySlug);
router.get('/check-value-usage', requirePermission('product.view'), checkVariantValueUsage);

router.post('/:id/values', requirePermission('product.edit'), addVariantAttributeValue);
router.post('/:id/values/replace-and-remove', requirePermission('product.edit'), replaceAndRemoveVariantValue);
router.post('/:id/values/:valueId/models', requirePermission('product.edit'), addVariantAttributeValueModel);

router.route('/')
    .get(requirePermission('product.view'), getVariantAttributes)
    .post(requirePermission('product.create'), variantValidation, validate, createVariantAttribute);

router.route('/:id')
    .get(requirePermission('product.view'), getVariantAttribute)
    .put(requirePermission('product.edit'), updateVariantAttribute)
    .delete(requirePermission('product.delete'), deleteVariantAttribute);

module.exports = router;
