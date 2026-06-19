const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const {
    getInvoices,
    getInvoiceById,
    createInvoice,
    updateInvoice,
    voidInvoice,
    deleteInvoice,
    checkReference,
    getNextReference,
    sendInvoiceByEmail,
} = require('../controllers/invoiceController');

router.use(protect);

router.route('/')
    .get(requirePermission('invoice.view'), getInvoices)
    .post(requirePermission('invoice.create'), createInvoice);

router.get('/check-reference', requirePermission('invoice.create'), checkReference);
router.get('/next-reference', requirePermission('invoice.create'), getNextReference);

router.delete('/:id/hard', requirePermission('invoice.delete'), deleteInvoice);

const sendInvoiceEmailValidation = [
    body('to')
        .notEmpty()
        .withMessage('Recipient email is required')
        .isEmail()
        .withMessage('Please enter a valid email address'),
    body('pdfBase64')
        .notEmpty()
        .withMessage('PDF attachment is required'),
    body('filename')
        .optional()
        .isLength({ max: 255 })
        .withMessage('Filename cannot exceed 255 characters'),
];

router.post(
    '/:id/send-email',
    requirePermission('invoice.view'),
    sendInvoiceEmailValidation,
    validate,
    sendInvoiceByEmail
);

router.route('/:id')
    .get(requirePermission('invoice.view'), getInvoiceById)
    .put(requirePermission('invoice.edit'), updateInvoice)
    .delete(requirePermission('invoice.void'), voidInvoice);

module.exports = router;
