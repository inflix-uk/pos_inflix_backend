const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    listNotebooks,
    createNotebook,
    updateNotebook,
    deleteNotebook,
    listNotes,
    createNote,
} = require('../controllers/notebookController');

router.use(protect);
router.use(requirePermission('sale.view'));

router.get('/', listNotebooks);
router.post('/', createNotebook);
router.patch('/:id', updateNotebook);
router.delete('/:id', deleteNotebook);

router.get('/:id/notes', listNotes);
router.post('/:id/notes', createNote);

module.exports = router;
