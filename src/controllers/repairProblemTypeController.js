const RepairProblemType = require('../models/RepairProblemType');
const asyncHandler = require('../middleware/asyncHandler');

const DEFAULT_PROBLEM_TYPES = [
    'Cracked screen',
    "Won't turn on",
    'Battery issue',
    'Water damage',
    'Charging port fault',
    'Speaker not working',
    'Camera not working',
    'Other',
];

async function ensureDefaults() {
    const count = await RepairProblemType.countDocuments();
    if (count > 0) return;
    await RepairProblemType.insertMany(
        DEFAULT_PROBLEM_TYPES.map((name, i) => ({
            name,
            isDefault: true,
            sortOrder: i,
        }))
    );
}

function normalizeName(raw) {
    return String(raw || '')
        .trim()
        .replace(/\s+/g, ' ');
}

// @desc    List repair problem types (seeds defaults on first use)
// @route   GET /api/repair-problem-types
// @access  Private (repair.view / create / edit)
exports.listProblemTypes = asyncHandler(async (req, res) => {
    await ensureDefaults();
    const list = await RepairProblemType.find()
        .sort({ sortOrder: 1, name: 1 })
        .lean();
    res.status(200).json({ success: true, data: list });
});

// @desc    Create a repair problem type
// @route   POST /api/repair-problem-types
// @access  Private (repair.create / edit)
exports.createProblemType = asyncHandler(async (req, res) => {
    const name = normalizeName(req.body?.name);
    if (!name) {
        return res.status(400).json({ success: false, message: 'Problem type name is required' });
    }

    const existing = await RepairProblemType.findOne({
        name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    }).lean();
    if (existing) {
        return res.status(200).json({ success: true, data: existing, existed: true });
    }

    const maxSort = await RepairProblemType.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean();
    const sortOrder = (maxSort?.sortOrder ?? DEFAULT_PROBLEM_TYPES.length - 1) + 1;
    const doc = await RepairProblemType.create({ name, isDefault: false, sortOrder });
    res.status(201).json({ success: true, data: doc, existed: false });
});

// @desc    Delete a repair problem type
// @route   DELETE /api/repair-problem-types/:id
// @access  Private (repair.create / edit)
exports.deleteProblemType = asyncHandler(async (req, res) => {
    const doc = await RepairProblemType.findById(req.params.id);
    if (!doc) {
        return res.status(404).json({ success: false, message: 'Problem type not found' });
    }
    const name = doc.name;
    await doc.deleteOne();
    res.status(200).json({ success: true, message: 'Problem type deleted', data: { _id: req.params.id, name } });
});

module.exports.DEFAULT_PROBLEM_TYPES = DEFAULT_PROBLEM_TYPES;
