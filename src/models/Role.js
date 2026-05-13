const mongoose = require('mongoose');

/**
 * Role: named set of permissions. Users get permissions via assigned roles.
 */
const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    description: { type: String, default: '' },
    permissions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Permission' }],
    /** Location assignments for this role. Users with this role inherit these locations.
     * Empty/null = role does not restrict locations (users use their own assignedLocationIds or all locations).
     * Non-empty = users with this role can access these locations (merged with user's assignedLocationIds if set).
     */
    assignedLocationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }]
}, {
    timestamps: true,
    collection: 'roles'
});

module.exports = require('../lib/tenantModel')('Role', roleSchema);
