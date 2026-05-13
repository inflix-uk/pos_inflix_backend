const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getPurchaseReturns,
    getPurchaseReturn,
    createPurchaseReturn,
    updatePurchaseReturn,
    deletePurchaseReturn,
    receiveRepair
} = require('../controllers/purchaseReturnController');

router.use(protect);
router.use(requirePermission('purchase.return'));

router.route('/')
    .get(getPurchaseReturns)
    .post(createPurchaseReturn);

router.post('/:id/receive-repair', receiveRepair);

router.route('/:id')
    .get(getPurchaseReturn)
    .put(updatePurchaseReturn)
    .delete(deletePurchaseReturn);

module.exports = router;
