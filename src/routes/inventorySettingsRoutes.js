const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getInventorySettings, updateInventorySettings } = require('../controllers/inventorySettingsController');

router.use(protect);

router
    .route('/')
    .get(requirePermission('settings.view', 'product.view', 'stock.view'), getInventorySettings)
    .put(requirePermission('settings.edit', 'inventory.settings.manage', 'product.edit'), updateInventorySettings);

module.exports = router;
