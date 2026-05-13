const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getPrintingSettings, updatePrintingSettings } = require('../controllers/printingSettingsController');

router.use(protect);

router.get('/', requirePermission('settings.view'), getPrintingSettings);
router.put('/', requirePermission('settings.manage'), updatePrintingSettings);

module.exports = router;
