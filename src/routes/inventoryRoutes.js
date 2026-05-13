const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const { getLowStocks } = require('../controllers/inventoryLowStocksController');

router.use(protect);
router.use(requireFeature('inventory'));

router.get('/low-stocks', requirePermission('product.view', 'stock.view'), getLowStocks);

module.exports = router;
