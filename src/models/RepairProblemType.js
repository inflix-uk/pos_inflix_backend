const mongoose = require('mongoose');

const repairProblemTypeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Problem type name is required'],
            trim: true,
            maxlength: [120, 'Problem type name cannot exceed 120 characters'],
        },
        /** Seeded defaults; still deletable by staff. */
        isDefault: { type: Boolean, default: false },
        sortOrder: { type: Number, default: 0 },
    },
    {
        timestamps: true,
        collection: 'repair_problem_types',
    }
);

repairProblemTypeSchema.index({ name: 1 }, { unique: true });
repairProblemTypeSchema.index({ sortOrder: 1, name: 1 });

module.exports = require('../lib/tenantModel')('RepairProblemType', repairProblemTypeSchema);
