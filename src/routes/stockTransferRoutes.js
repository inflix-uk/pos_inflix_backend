const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const {
    list,
    getById,
    create,
    update,
    addLine,
    removeLine,
    addSerial,
    removeSerial,
    dispatch,
    receive,
    cancel,
    validateSerial,
    getQuantityLineOptions
} = require('../controllers/stockTransferController');

router.use(protect);
router.use(requireFeature('stock_transfer'));

router.get('/', requirePermission('stock_transfer.view'), list);
router.get('/quantity-line-options', requirePermission('stock_transfer.view', 'stock_transfer.create'), getQuantityLineOptions);
router.get('/:id/validate-serial', requirePermission('stock_transfer.view', 'stock_transfer.create'), validateSerial);
router.get('/:id', requirePermission('stock_transfer.view'), getById);
router.post('/', requirePermission('stock_transfer.create'), create);
router.put('/:id', requirePermission('stock_transfer.create'), update);
router.post('/:id/lines', requirePermission('stock_transfer.create'), addLine);
router.delete('/:id/lines/:lineId', requirePermission('stock_transfer.create'), removeLine);
router.post('/:id/serials', requirePermission('stock_transfer.create'), addSerial);
router.delete('/:id/serials/:serialOrImei', requirePermission('stock_transfer.create'), removeSerial);
router.post('/:id/dispatch', requirePermission('stock_transfer.dispatch'), dispatch);
router.post('/:id/receive', requirePermission('stock_transfer.receive'), receive);
router.post('/:id/cancel', requirePermission('stock_transfer.cancel'), cancel);

module.exports = router;
