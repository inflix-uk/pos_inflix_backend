const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getGeneralSettings,
    updateSalesAutoSelectAccount,
    updateSalesMode,
    updateNegativeStock,
    setupAdminTotp,
    verifyAndEnableAdminTotp,
    disableAdminTotp
} = require('../controllers/generalSettingsController');

router.use(protect);

router.get('/', requirePermission('settings.view'), getGeneralSettings);
router.put('/sales-auto-select-account', requirePermission('settings.manage'), updateSalesAutoSelectAccount);
router.put('/sales-mode', requirePermission('settings.manage'), updateSalesMode);
router.put('/negative-stock', requirePermission('settings.manage'), updateNegativeStock);

router.post('/2fa/setup', requirePermission('settings.manage'), setupAdminTotp);
router.post('/2fa/verify-enable', requirePermission('settings.manage'), verifyAndEnableAdminTotp);
router.post('/2fa/disable', requirePermission('settings.manage'), disableAdminTotp);

module.exports = router;
