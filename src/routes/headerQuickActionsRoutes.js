const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getHeaderQuickActions, updateHeaderQuickActions } = require('../controllers/headerQuickActionsController');

router.use(protect);

router.get('/', requirePermission('settings.view', 'sale.create', 'repair.create', 'purchase.create'), getHeaderQuickActions);
router.put('/', requirePermission('settings.manage'), updateHeaderQuickActions);

module.exports = router;
