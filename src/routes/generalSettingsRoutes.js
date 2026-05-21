const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
<<<<<<< HEAD
const {
    getGeneralSettings,
    updateSalesAutoSelectAccount,
    updateSalesMode,
    updateNegativeStock,
    updateRefundOtpThreshold,
    setupAdminTotp,
    verifyAndEnableAdminTotp,
    disableAdminTotp
} = require('../controllers/generalSettingsController');
=======
const { getGeneralSettings, updateSalesAutoSelectAccount, updateSalesMode, updateNegativeStock } = require('../controllers/generalSettingsController');
>>>>>>> 691dc86c5ee9cf77e6201fb400f473562185f26d

router.use(protect);

router.get('/', requirePermission('settings.view'), getGeneralSettings);
router.put('/sales-auto-select-account', requirePermission('settings.manage'), updateSalesAutoSelectAccount);
router.put('/sales-mode', requirePermission('settings.manage'), updateSalesMode);
router.put('/negative-stock', requirePermission('settings.manage'), updateNegativeStock);
router.put('/refund-otp-threshold', requirePermission('settings.manage'), updateRefundOtpThreshold);

module.exports = router;
