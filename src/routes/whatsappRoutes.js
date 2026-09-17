const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const ctrl = require('../controllers/whatsappController');

router.use(protect);

// Connection status is needed by anyone sending an invoice; the QR is stripped for non-managers.
router.get('/status', ctrl.getStatus);
router.post('/start', requirePermission('settings.edit'), ctrl.startSession);
router.post('/logout', requirePermission('settings.edit'), ctrl.logout);
router.post('/send', requirePermission('settings.edit'), ctrl.sendTest);

router.route('/settings')
    .get(requirePermission('settings.view'), ctrl.getSettings)
    .put(requirePermission('settings.edit'), ctrl.updateSettings);

router.get('/queue', requirePermission('settings.view'), ctrl.getQueue);
router.post('/queue/:id/cancel', requirePermission('settings.edit'), ctrl.cancelMessage);
router.post('/queue/:id/retry', requirePermission('settings.edit'), ctrl.retryMessage);

module.exports = router;
