const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getSalesReturns,
    getSalesReturnById,
    createSalesReturn,
    updateSalesReturn,
    deleteSalesReturn,
} = require('../controllers/salesReturnController');

router.use(protect);

router.route('/')
    .get(requirePermission('return.create', 'refund.issue', 'sale.view'), getSalesReturns)
    .post(requirePermission('return.create'), createSalesReturn);

router.route('/:id')
    .get(requirePermission('return.create', 'refund.issue', 'sale.view'), getSalesReturnById)
    .put(requirePermission('return.create', 'refund.issue'), updateSalesReturn)
    .delete(requirePermission('return.create', 'refund.issue'), deleteSalesReturn);

module.exports = router;
