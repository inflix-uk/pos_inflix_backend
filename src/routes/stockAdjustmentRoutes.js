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
    validateSerial,
    post,
    cancel,
    getReasonCodes
} = require('../controllers/stockAdjustmentController');

router.use(protect);
router.use(requireFeature('stock_adjustment'));

router.get('/', requirePermission('stock_adjustment.view'), list);
router.get('/reason-codes', requirePermission('stock_adjustment.view', 'stock_adjustment.create'), getReasonCodes);
router.get('/:id/validate-serial', requirePermission('stock_adjustment.view', 'stock_adjustment.create'), validateSerial);
router.get('/:id', requirePermission('stock_adjustment.view'), getById);
router.post('/', requirePermission('stock_adjustment.create'), create);
router.put('/:id', requirePermission('stock_adjustment.edit_draft'), update);
router.post('/:id/lines', requirePermission('stock_adjustment.create', 'stock_adjustment.edit_draft'), addLine);
router.delete('/:id/lines/:lineId', requirePermission('stock_adjustment.create', 'stock_adjustment.edit_draft'), removeLine);
router.post('/:id/serials', requirePermission('stock_adjustment.create', 'stock_adjustment.edit_draft'), addSerial);
router.delete('/:id/serials/:serialOrImei', requirePermission('stock_adjustment.create', 'stock_adjustment.edit_draft'), removeSerial);
router.post('/:id/post', requirePermission('stock_adjustment.post'), post);
router.post('/:id/cancel', requirePermission('stock_adjustment.cancel'), cancel);

module.exports = router;
