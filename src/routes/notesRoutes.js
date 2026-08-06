const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getNote, updateNote, deleteNote } = require('../controllers/notebookController');

router.use(protect);
router.use(requirePermission('sale.view'));

router.get('/:id', getNote);
router.patch('/:id', updateNote);
router.delete('/:id', deleteNote);

module.exports = router;
