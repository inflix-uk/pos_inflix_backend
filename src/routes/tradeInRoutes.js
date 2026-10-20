const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getTradeIns,
    getTradeInMeta,
    createDraft,
    getTradeIn,
    getTradeInFiles,
    putTradeInFile,
    deleteTradeInFile,
    setTermsAccepted,
    createUploadLink,
    completeTradeIn,
    deleteDraft
} = require('../controllers/tradeInController');

router.use(protect);

router.get('/', requirePermission('tradein.view'), getTradeIns);
router.get('/meta', requirePermission('tradein.view', 'tradein.create'), getTradeInMeta);
router.post('/drafts', requirePermission('tradein.create'), createDraft);

router.route('/:id')
    .get(requirePermission('tradein.view', 'tradein.create'), getTradeIn)
    .delete(requirePermission('tradein.create'), deleteDraft);

router.get('/:id/files', requirePermission('tradein.view', 'tradein.create'), getTradeInFiles);
router.route('/:id/files/:kind')
    .put(requirePermission('tradein.create'), putTradeInFile)
    .delete(requirePermission('tradein.create'), deleteTradeInFile);

router.put('/:id/terms', requirePermission('tradein.create'), setTermsAccepted);
router.post('/:id/upload-link', requirePermission('tradein.create'), createUploadLink);
router.post('/:id/complete', requirePermission('tradein.create'), completeTradeIn);

module.exports = router;
