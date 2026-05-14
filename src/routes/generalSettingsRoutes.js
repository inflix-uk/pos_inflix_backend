const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getGeneralSettings, updateSalesAutoSelectAccount, updateSalesMode, updateNegativeStock } = require('../controllers/generalSettingsController');

router.use(protect);

router.get('/', requirePermission('settings.view'), getGeneralSettings);
router.put('/sales-auto-select-account', requirePermission('settings.manage'), updateSalesAutoSelectAccount);
router.put('/sales-mode', requirePermission('settings.manage'), updateSalesMode);
router.put('/negative-stock', requirePermission('settings.manage'), updateNegativeStock);

module.exports = router;
