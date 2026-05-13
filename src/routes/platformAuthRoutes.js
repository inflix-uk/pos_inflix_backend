const express = require('express');
const router = express.Router();
const { requirePlatformAuth } = require('../middleware/auth');
const platformAuthController = require('../controllers/platformAuthController');

router.post('/login', platformAuthController.login);
router.post('/logout', requirePlatformAuth, platformAuthController.logout);
router.get('/me', requirePlatformAuth, platformAuthController.me);

module.exports = router;
