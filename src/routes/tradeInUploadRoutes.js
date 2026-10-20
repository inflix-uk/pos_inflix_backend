/**
 * Public phone-upload routes for trade-ins (no staff login).
 * Access is by the random token in the QR code shown on the staff computer; it expires after 30 minutes.
 * Mounted at /api/trade-in-upload and skipped by the login gate in routes/index.js.
 */
const express = require('express');
const router = express.Router();
const { publicGetSession, publicPutFile, publicAcceptTerms } = require('../controllers/tradeInController');

router.get('/:token', publicGetSession);
router.put('/:token/files/:kind', publicPutFile);
router.post('/:token/accept-terms', publicAcceptTerms);

module.exports = router;
