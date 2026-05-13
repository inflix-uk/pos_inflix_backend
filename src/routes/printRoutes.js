const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getReceiptEscpos, getSalePrintContext } = require('../controllers/printController');

router.use(protect);

// Sale + resolved location for invoice/receipt header (frontend PDF)
router.get('/sale-print-context/:saleId', requirePermission('sale.view'), getSalePrintContext);

// Receipt: ESC/POS raw bytes (base64) for silent printing
router.get('/receipt/:saleId', requirePermission('sale.view'), getReceiptEscpos);

module.exports = router;
