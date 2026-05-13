const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const {
    getRepairs,
    getRepair,
    createRepair,
    updateRepair,
    deleteRepair,
    takePayment,
    searchRepairItems
} = require('../controllers/repairController');

const STATUS_VALUES = ['pending', 'in_progress', 'waiting_parts', 'completed', 'cancelled', 'collected', 'redo'];

router.use(protect);
router.use(requireFeature('repairs'));

const createRepairValidation = [
    body('customerName').notEmpty().trim().withMessage('Customer name is required'),
    body('deviceDescription').notEmpty().trim().withMessage('Device description is required'),
    body('status').optional().isIn(STATUS_VALUES).withMessage('Invalid status'),
    body('estimatedCost').optional().isFloat({ min: 0 }).withMessage('Estimated cost must be a non-negative number'),
    body('actualCost').optional().isFloat({ min: 0 }).withMessage('Actual cost must be a non-negative number')
];

const updateRepairValidation = [
    body('customerName').optional().notEmpty().trim().withMessage('Customer name cannot be empty'),
    body('deviceDescription').optional().trim(),
    body('status').optional({ nullable: true }).isIn(STATUS_VALUES).withMessage('Invalid status'),
    body('estimatedCost').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Estimated cost must be a non-negative number'),
    body('actualCost').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Actual cost must be a non-negative number')
];

router.get('/items/search', requirePermission('repair.view', 'repair.edit', 'repair.create'), searchRepairItems);

router.route('/')
    .get(requirePermission('repair.view'), getRepairs)
    .post(requirePermission('repair.create'), createRepairValidation, validate, createRepair);

router.post('/:id/take-payment', requirePermission('repair.edit'), takePayment);

router.route('/:id')
    .get(requirePermission('repair.view'), getRepair)
    .put(requirePermission('repair.edit'), updateRepairValidation, validate, updateRepair)
    .delete(requirePermission('repair.delete'), deleteRepair);

module.exports = router;
