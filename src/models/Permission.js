const mongoose = require('mongoose');

/**
 * Permission catalog. Keys are used for can(user, key) checks.
 * Seeded once; rarely changed.
 */
const permissionSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    description: { type: String, default: '' },
    group: { type: String, default: 'Other' }
}, {
    timestamps: true,
    collection: 'permissions'
});

permissionSchema.index({ group: 1 });

module.exports = require('../lib/tenantModel')('Permission', permissionSchema);
