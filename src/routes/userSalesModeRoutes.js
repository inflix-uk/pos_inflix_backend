const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getMySalesMode, updateMySalesMode } = require('../controllers/userSalesModeController');

router.use(protect);

router.get('/', requirePermission('settings.sales_mode', 'settings.manage'), getMySalesMode);
router.put('/', requirePermission('settings.sales_mode'), updateMySalesMode);

module.exports = router;
