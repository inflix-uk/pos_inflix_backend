const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getLocations,
    getLocation,
    createLocation,
    updateLocation,
    deleteLocation,
    getActiveLocations
} = require('../controllers/locationController');

// All routes require authentication
router.use(protect);

// Validation rules - only name is required; empty strings treated as "not provided"
const locationValidation = [
    body('name').notEmpty().trim().withMessage('Location name is required'),
    body('type').optional({ checkFalsy: true }).isIn(['store', 'warehouse']).withMessage('Type must be store or warehouse'),
    body('contactPerson').optional({ checkFalsy: true }).trim(),
    body('phone').optional({ checkFalsy: true }).trim(),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Please enter a valid email'),
    body('address').optional({ checkFalsy: true }).trim(),
    body('city').optional({ checkFalsy: true }).trim(),
    body('country').optional({ checkFalsy: true }).trim()
];

router.get('/active', requirePermission('settings.view', 'product.view', 'stock_transfer.view', 'stock_adjustment.view'), getActiveLocations);

router.route('/')
    .get(requirePermission('settings.view', 'product.view', 'stock_transfer.view', 'stock_adjustment.view'), getLocations)
    .post(requirePermission('settings.edit'), locationValidation, validate, createLocation);

router.route('/:id')
    .get(requirePermission('settings.view', 'product.view', 'stock_transfer.view', 'stock_adjustment.view'), getLocation)
    .put(requirePermission('settings.edit'), updateLocation)
    .delete(requirePermission('settings.edit'), deleteLocation);

module.exports = router;
