const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getPrintingSettings, updatePrintingSettings } = require('../controllers/printingSettingsController');

router.use(protect);

router.get('/', requirePermission('settings.view', 'settings.printing', 'settings.manage'), getPrintingSettings);
router.put('/', requirePermission('settings.printing', 'settings.manage'), updatePrintingSettings);

module.exports = router;
