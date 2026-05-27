const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/whatsappController');

router.get('/status', ctrl.getStatus);
router.post('/start', ctrl.startSession);
router.post('/logout', ctrl.logout);
router.post('/send', ctrl.sendTest);

module.exports = router;
