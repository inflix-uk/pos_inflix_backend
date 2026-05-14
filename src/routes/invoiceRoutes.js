const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getInvoices,
    getInvoiceById,
    createInvoice,
    updateInvoice,
    voidInvoice,
    deleteInvoice,
    checkReference,
} = require('../controllers/invoiceController');

router.use(protect);

router.route('/')
    .get(requirePermission('invoice.view'), getInvoices)
    .post(requirePermission('invoice.create'), createInvoice);

router.get('/check-reference', requirePermission('invoice.create'), checkReference);

router.delete('/:id/hard', requirePermission('invoice.delete'), deleteInvoice);

router.route('/:id')
    .get(requirePermission('invoice.view'), getInvoiceById)
    .put(requirePermission('invoice.edit'), updateInvoice)
    .delete(requirePermission('invoice.void'), voidInvoice);

module.exports = router;
