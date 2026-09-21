const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const { getSales, getSaleById, createSale, updateSale, deleteSale, hardDeleteSale, getSoldSerials, getReturnLines, getFindBySerial, takePayment, checkReference, sendSaleByEmail, sendSaleByWhatsapp } = require('../controllers/salesController');

router.use(protect);

router.route('/')
    .get(requirePermission('sale.view'), getSales)
    .post(requirePermission('sale.create'), createSale);

router.get('/check-reference', requirePermission('sale.create'), checkReference);
router.get('/sold-serials', requirePermission('sale.view'), getSoldSerials);
router.get('/find-by-serial/:serial', requirePermission('sale.view'), getFindBySerial);

router.get('/:id/return-lines', requirePermission('sale.view'), getReturnLines);

router.post('/:id/take-payment', requirePermission('sale.edit'), takePayment);

const sendEmailValidation = [
    body('to').notEmpty().withMessage('Recipient email is required').isEmail().withMessage('Please enter a valid email address'),
    body('pdfBase64').notEmpty().withMessage('PDF attachment is required'),
    body('filename').optional().isLength({ max: 255 }).withMessage('Filename cannot exceed 255 characters'),
];

router.post('/:id/send-email', requirePermission('sale.view'), sendEmailValidation, validate, sendSaleByEmail);
router.post('/:id/send-whatsapp', requirePermission('sale.view'), sendSaleByWhatsapp);

router.delete('/:id/hard', requirePermission('sale.delete'), hardDeleteSale);

router.route('/:id')
    .get(requirePermission('sale.view'), getSaleById)
    .put(requirePermission('sale.edit'), updateSale)
    .delete(requirePermission('sale.void'), deleteSale);

module.exports = router;
