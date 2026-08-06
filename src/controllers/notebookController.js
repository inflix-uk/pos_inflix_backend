const Notebook = require('../models/Notebook');
const Note = require('../models/Note');
const asyncHandler = require('../middleware/asyncHandler');

const DEFAULT_NOTEBOOK_NAME = 'Notes';
const DEFAULT_NOTEBOOK_COLOR = 'sky';

async function ensureDefaultNotebook(userId) {
    const count = await Notebook.countDocuments();
    if (count > 0) return null;
    return Notebook.create({
        name: DEFAULT_NOTEBOOK_NAME,
        color: DEFAULT_NOTEBOOK_COLOR,
        createdBy: userId || null,
    });
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function noteListItem(doc) {
    const snippet = stripHtml(doc.bodyHtml).slice(0, 140);
    return {
        _id: doc._id,
        notebookId: doc.notebookId,
        title: doc.title || 'Untitled',
        color: doc.color || '',
        snippet,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

// @desc    List notebooks (ensures default exists); includes note counts
// @route   GET /api/notebooks
exports.listNotebooks = asyncHandler(async (req, res) => {
    await ensureDefaultNotebook(req.user && req.user._id);
    const notebooks = await Notebook.find().sort({ name: 1 }).lean();
    const counts = await Note.aggregate([
        { $group: { _id: '$notebookId', count: { $sum: 1 } } },
    ]);
    const countById = {};
    for (const c of counts) {
        if (c._id) countById[String(c._id)] = c.count;
    }
    const data = notebooks.map((n) => ({
        ...n,
        noteCount: countById[String(n._id)] || 0,
    }));
    res.status(200).json({ success: true, data });
});

// @desc    Create notebook
// @route   POST /api/notebooks
exports.createNotebook = asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Notebook name is required' });
    }
    const color = req.body.color || DEFAULT_NOTEBOOK_COLOR;
    const doc = await Notebook.create({
        name,
        color,
        createdBy: req.user && req.user._id ? req.user._id : null,
    });
    res.status(201).json({ success: true, data: { ...doc.toObject(), noteCount: 0 } });
});

// @desc    Update notebook
// @route   PATCH /api/notebooks/:id
exports.updateNotebook = asyncHandler(async (req, res) => {
    const notebook = await Notebook.findById(req.params.id);
    if (!notebook) {
        return res.status(404).json({ success: false, message: 'Notebook not found' });
    }
    if (typeof req.body.name === 'string') {
        const name = req.body.name.trim();
        if (!name) {
            return res.status(400).json({ success: false, message: 'Notebook name is required' });
        }
        notebook.name = name;
    }
    if (typeof req.body.color === 'string' && req.body.color) {
        notebook.color = req.body.color;
    }
    await notebook.save();
    const noteCount = await Note.countDocuments({ notebookId: notebook._id });
    res.status(200).json({ success: true, data: { ...notebook.toObject(), noteCount } });
});

// @desc    Delete notebook and its notes
// @route   DELETE /api/notebooks/:id
exports.deleteNotebook = asyncHandler(async (req, res) => {
    const notebook = await Notebook.findById(req.params.id);
    if (!notebook) {
        return res.status(404).json({ success: false, message: 'Notebook not found' });
    }
    const remaining = await Notebook.countDocuments({ _id: { $ne: notebook._id } });
    if (remaining === 0) {
        return res.status(400).json({ success: false, message: 'Cannot delete the last notebook' });
    }
    await Note.deleteMany({ notebookId: notebook._id });
    await notebook.deleteOne();
    res.status(200).json({ success: true, data: { _id: notebook._id } });
});

// @desc    List notes in a notebook
// @route   GET /api/notebooks/:id/notes
exports.listNotes = asyncHandler(async (req, res) => {
    const notebook = await Notebook.findById(req.params.id).lean();
    if (!notebook) {
        return res.status(404).json({ success: false, message: 'Notebook not found' });
    }
    const q = String(req.query.q || '').trim();
    const filter = { notebookId: notebook._id };
    if (q) {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ title: re }, { bodyHtml: re }];
    }
    const notes = await Note.find(filter).sort({ updatedAt: -1 }).lean();
    res.status(200).json({ success: true, data: notes.map(noteListItem) });
});

// @desc    Create note in notebook
// @route   POST /api/notebooks/:id/notes
exports.createNote = asyncHandler(async (req, res) => {
    const notebook = await Notebook.findById(req.params.id).lean();
    if (!notebook) {
        return res.status(404).json({ success: false, message: 'Notebook not found' });
    }
    const title = typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : 'Untitled';
    const bodyHtml = typeof req.body.bodyHtml === 'string' ? req.body.bodyHtml : '';
    const color = typeof req.body.color === 'string' ? req.body.color : '';
    const userId = req.user && req.user._id ? req.user._id : null;
    const doc = await Note.create({
        notebookId: notebook._id,
        title,
        bodyHtml,
        color,
        createdBy: userId,
        updatedBy: userId,
    });
    res.status(201).json({ success: true, data: doc });
});

// @desc    Get one note
// @route   GET /api/notes/:id
exports.getNote = asyncHandler(async (req, res) => {
    const note = await Note.findById(req.params.id).lean();
    if (!note) {
        return res.status(404).json({ success: false, message: 'Note not found' });
    }
    res.status(200).json({ success: true, data: note });
});

// @desc    Update note
// @route   PATCH /api/notes/:id
exports.updateNote = asyncHandler(async (req, res) => {
    const note = await Note.findById(req.params.id);
    if (!note) {
        return res.status(404).json({ success: false, message: 'Note not found' });
    }
    if (typeof req.body.title === 'string') {
        note.title = req.body.title.trim() || 'Untitled';
    }
    if (typeof req.body.bodyHtml === 'string') {
        note.bodyHtml = req.body.bodyHtml;
    }
    if (typeof req.body.color === 'string') {
        note.color = req.body.color;
    }
    if (req.body.notebookId) {
        const target = await Notebook.findById(req.body.notebookId).lean();
        if (!target) {
            return res.status(400).json({ success: false, message: 'Target notebook not found' });
        }
        note.notebookId = target._id;
    }
    note.updatedBy = req.user && req.user._id ? req.user._id : null;
    await note.save();
    res.status(200).json({ success: true, data: note });
});

// @desc    Delete note
// @route   DELETE /api/notes/:id
exports.deleteNote = asyncHandler(async (req, res) => {
    const note = await Note.findById(req.params.id);
    if (!note) {
        return res.status(404).json({ success: false, message: 'Note not found' });
    }
    await note.deleteOne();
    res.status(200).json({ success: true, data: { _id: note._id } });
});
