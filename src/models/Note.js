const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
    notebookId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Notebook',
        required: true,
        index: true,
    },
    title: {
        type: String,
        trim: true,
        default: 'Untitled',
        maxlength: [300, 'Title cannot exceed 300 characters'],
    },
    bodyHtml: {
        type: String,
        default: '',
        maxlength: [500000, 'Note body is too large'],
    },
    /** Optional colour tag shown in the editor */
    color: {
        type: String,
        trim: true,
        default: '',
        maxlength: [32, 'Color tag too long'],
    },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
}, {
    timestamps: true,
    collection: 'notes',
});

noteSchema.index({ notebookId: 1, pinned: -1, pinnedAt: -1, updatedAt: -1 });
noteSchema.index({ notebookId: 1, updatedAt: -1 });

module.exports = require('../lib/tenantModel')('Note', noteSchema);
