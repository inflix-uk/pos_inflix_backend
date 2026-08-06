const mongoose = require('mongoose');

const NOTEBOOK_COLORS = [
    'orange', 'amber', 'green', 'emerald', 'sky', 'blue', 'violet', 'purple', 'rose', 'slate'
];

const notebookSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: [120, 'Notebook name cannot exceed 120 characters'],
    },
    color: {
        type: String,
        enum: NOTEBOOK_COLORS,
        default: 'sky',
    },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
}, {
    timestamps: true,
    collection: 'notebooks',
});

notebookSchema.index({ pinned: -1, pinnedAt: -1, name: 1 });
notebookSchema.index({ name: 1 });
notebookSchema.index({ updatedAt: -1 });

module.exports = require('../lib/tenantModel')('Notebook', notebookSchema);
module.exports.NOTEBOOK_COLORS = NOTEBOOK_COLORS;
