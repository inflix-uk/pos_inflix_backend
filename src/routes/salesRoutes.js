const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getSales, getSaleById, createSale, updateSale, deleteSale, hardDeleteSale, getSoldSerials, getReturnLines, getFindBySerial, takePayment, checkReference } = require('../controllers/salesController');

router.use(protect);

router.route('/')
    .get(requirePermission('sale.view'), getSales)
    .post(requirePermission('sale.create'), createSale);

router.get('/check-reference', requirePermission('sale.create'), checkReference);
router.get('/sold-serials', requirePermission('sale.view'), getSoldSerials);
router.get('/find-by-serial/:serial', requirePermission('sale.view'), getFindBySerial);

router.get('/:id/return-lines', requirePermission('sale.view'), getReturnLines);

router.post('/:id/take-payment', requirePermission('sale.edit'), takePayment);

router.delete('/:id/hard', requirePermission('sale.delete'), hardDeleteSale);

router.route('/:id')
    .get(requirePermission('sale.view'), getSaleById)
    .put(requirePermission('sale.edit'), updateSale)
    .delete(requirePermission('sale.void'), deleteSale);

module.exports = router;
