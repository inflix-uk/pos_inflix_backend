const Repair = require('../models/Repair');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const asyncHandler = require('../middleware/asyncHandler');
const metricsService = require('../services/metricsService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const REPAIR_CACHE_NAMESPACES = ['repairs:list', 'paymentAccounts:list', 'customers:list'];
async function invalidateRepairCaches(tenantId) {
    await cache.bumpMany(REPAIR_CACHE_NAMESPACES, tenantId);
}

const round2 = (n) => (n != null && typeof n === 'number' ? Math.round(n * 100) / 100 : null);

function formatProblemTypeFromProblems(problems) {
    if (!Array.isArray(problems) || problems.length === 0) return '';
    return problems
        .map((p) => {
            const label = (p.label || '').trim();
            if (!label) return '';
            const cost = p.estimatedCost != null && Number.isFinite(Number(p.estimatedCost))
                ? round2(Number(p.estimatedCost))
                : null;
            return cost != null && cost > 0 ? `${label} (£${cost.toFixed(2)})` : label;
        })
        .filter(Boolean)
        .join(', ');
}

function sumProblemEstimates(problems) {
    if (!Array.isArray(problems) || problems.length === 0) return null;
    let sum = 0;
    let any = false;
    for (const p of problems) {
        const n = Number(p.estimatedCost);
        if (Number.isFinite(n) && n > 0) {
            sum += n;
            any = true;
        }
    }
    return any ? round2(sum) : null;
}

function normalizeDeviceProblemsInput(device) {
    const d = { ...device };
    let problems = Array.isArray(d.problems)
        ? d.problems
            .map((p) => ({
                label: (p.label || '').trim(),
                estimatedCost:
                    p.estimatedCost != null && p.estimatedCost !== '' && Number.isFinite(Number(p.estimatedCost))
                        ? round2(Math.max(0, Number(p.estimatedCost)))
                        : null
            }))
            .filter((p) => p.label)
        : [];

    if (problems.length === 0 && d.problemType) {
        problems = String(d.problemType)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((label) => ({ label, estimatedCost: null }));
    }

    if (problems.length > 0) {
        d.problems = problems;
        d.problemType = formatProblemTypeFromProblems(problems) || d.problemType || '';
        const fromProblems = sumProblemEstimates(problems);
        if (fromProblems != null) d.estimatedCost = fromProblems;
    }

    return d;
}

function normalizeDevicesInput(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return devices;
    return devices.map((device) => normalizeDeviceProblemsInput(device));
}

function mapDeviceForApi(d) {
    const problems = Array.isArray(d.problems)
        ? d.problems.map((p) => ({
            label: (p.label || '').trim(),
            estimatedCost: p.estimatedCost != null ? round2(p.estimatedCost) : null
        })).filter((p) => p.label)
        : [];
    const fromProblems = sumProblemEstimates(problems);
    const estimatedCost = fromProblems != null ? fromProblems : round2(d.estimatedCost);
    return {
        deviceDescription: d.deviceDescription || '',
        serialNumber: d.serialNumber || '',
        problemType: d.problemType || (problems.length > 0 ? formatProblemTypeFromProblems(problems) : ''),
        problems,
        devicePassword: d.devicePassword || '',
        estimatedCost,
        notes: d.notes || ''
    };
}

function mapDevicesForApi(repair) {
    if (repair.devices && repair.devices.length > 0) {
        return repair.devices.map((d) => mapDeviceForApi(d));
    }
    return [mapDeviceForApi({
        deviceDescription: repair.deviceDescription || '',
        serialNumber: repair.serialNumber || '',
        problemType: repair.problemType || '',
        devicePassword: repair.devicePassword || '',
        estimatedCost: repair.estimatedCost,
        notes: repair.notes || ''
    })];
}

function syncLegacyFieldsFromDevices(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return {};
    const normalized = normalizeDevicesInput(devices);
    const first = normalized[0];
    const ticketEst = normalized.reduce((sum, d) => sum + (Number(d.estimatedCost) || 0), 0);
    return {
        devices: normalized,
        deviceDescription: (first.deviceDescription && first.deviceDescription.trim()) ? first.deviceDescription.trim() : '',
        serialNumber: (first.serialNumber && first.serialNumber.trim()) ? first.serialNumber.trim() : '',
        problemType: first.problemType || '',
        devicePassword: (first.devicePassword && first.devicePassword.trim()) ? first.devicePassword.trim() : '',
        estimatedCost: ticketEst > 0 ? round2(ticketEst) : (first.estimatedCost != null ? first.estimatedCost : null),
        notes: (first.notes && first.notes.trim()) ? first.notes.trim() : ''
    };
}

/** Amount due for a repair: sum of repairItems, or actualCost, or 0 */
function getRepairAmountDue(repair) {
    if (repair.repairItems && Array.isArray(repair.repairItems) && repair.repairItems.length > 0) {
        const sum = repair.repairItems.reduce((acc, item) => acc + (Number(item.amount) || 0), 0);
        return round2(sum) || 0;
    }
    return round2(repair.actualCost) != null ? round2(repair.actualCost) : 0;
}

// @desc    Get all repairs
// @route   GET /api/repairs
// @access  Private
exports.getRepairs = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);
    const mongoose = require('mongoose');

    const userScope = getUserLocationScope(req.user);
    const sortBy = req.query.sortBy === 'oldest' ? 'createdAt' : '-createdAt';

    const params = {
        page, limit,
        status: req.query.status || null,
        search: req.query.search || null,
        sortBy,
        scope: Array.isArray(userScope) && userScope.length > 0 ? [...userScope].sort() : null,
    };

    const payload = await cache.cached(
        { ns: 'repairs:list', tenantId, params, ttlSec: TTL.TRANSACTIONAL },
        async () => {
            const query = tenantId === 'default' ? { $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] } : { tenantId };

            // Phase 3: Location-based access control
            if (userScope && userScope.length > 0) {
                // Non-admin: filter by assigned locations
                query.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
            }
            // Admin or empty assignedLocationIds: no location filter (see all locations)

            if (req.query.status && req.query.status !== 'all') {
                query.status = req.query.status;
            }

            if (req.query.search) {
                const search = req.query.search.trim();
                const rx = { $regex: search, $options: 'i' };
                const orClause = [
                    { reference: rx },
                    { customerName: rx },
                    { contactPhone: rx },
                    { deviceDescription: rx },
                    { serialNumber: rx },
                    { notes: rx }
                ];
                // Match by Customer.contactName / contact fields so search by the contact's name
                // returns repairs even when the snapshot customerName is the company name.
                const matchingCustomers = await Customer.find({
                    tenantId,
                    $or: [{ contactName: rx }, { email: rx }, { mobile: rx }],
                })
                    .select('_id')
                    .lean();
                const matchedIds = (matchingCustomers || []).map((c) => c._id).filter(Boolean);
                if (matchedIds.length > 0) {
                    orClause.push({ customerId: { $in: matchedIds } });
                }
                query.$or = orClause;
            }

            const [total, repairs] = await Promise.all([
                Repair.countDocuments(query),
                Repair.find(query)
                    .populate('createdBy', 'name')
                    .populate('saleId', 'total reference')
                    .populate('paymentIds', 'total reference paymentKind createdAt')
                    .skip(startIndex)
                    .limit(limit)
                    .sort(sortBy)
                    .lean()
            ]);

            const data = repairs.map((r) => {
                let amountTaken = null;
                if (r.paymentIds && Array.isArray(r.paymentIds) && r.paymentIds.length > 0) {
                    amountTaken = round2(r.paymentIds.reduce((sum, s) => sum + (Number(s.total) || 0), 0));
                } else if (r.saleId && typeof r.saleId.total === 'number') {
                    amountTaken = round2(r.saleId.total);
                }
                return {
                    ...r,
                    estimatedCost: round2(r.estimatedCost),
                    actualCost: round2(r.actualCost),
                    createdByName: r.createdBy && r.createdBy.name ? r.createdBy.name : null,
                    amountTaken
                };
            });

            return { total, data, pages: Math.ceil(total / limit) || 1 };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.data.length,
        total: payload.total,
        page,
        pages: payload.pages,
        data: payload.data
    });
});

// @desc    Get single repair
// @route   GET /api/repairs/:id
// @access  Private
exports.getRepair = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const repairQuery = tenantId === 'default'
        ? { _id: req.params.id, $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] }
        : { _id: req.params.id, tenantId };
    const repair = await Repair.findOne(repairQuery)
        .populate('saleId', 'reference total paymentMethod createdAt paymentKind')
        .populate('paymentIds', 'reference total paymentMethod createdAt paymentKind')
        .populate('locationId', 'name type')
        .lean();

    if (!repair) {
        return res.status(404).json({
            success: false,
            message: 'Repair not found'
        });
    }
    
    // Phase 3: Location-based access control - verify user can access this repair's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && repair.locationId) {
        const repairLocationId = repair.locationId.toString ? repair.locationId.toString() : String(repair.locationId);
        if (!userScope.includes(repairLocationId)) {
            return res.status(404).json({
                success: false,
                message: 'Repair not found'
            });
        }
    }

    const payments = (repair.paymentIds && repair.paymentIds.length > 0)
        ? repair.paymentIds.map((s) => ({
            _id: s._id,
            reference: s.reference,
            total: round2(s.total),
            paymentMethod: s.paymentMethod,
            createdAt: s.createdAt,
            paymentKind: s.paymentKind || 'full'
        }))
        : (repair.saleId ? [{
            _id: repair.saleId._id,
            reference: repair.saleId.reference,
            total: round2(repair.saleId.total),
            paymentMethod: repair.saleId.paymentMethod,
            createdAt: repair.saleId.createdAt,
            paymentKind: repair.saleId.paymentKind || 'full'
        }] : []);

    const totalTaken = payments.length > 0 ? payments.reduce((sum, p) => sum + (p.total || 0), 0) : 0;
    const sale = payments.length > 0 ? payments[payments.length - 1] : null;

    const devices = mapDevicesForApi(repair);

    const data = {
        ...repair,
        devices,
        estimatedCost: round2(repair.estimatedCost),
        actualCost: round2(repair.actualCost),
        payments,
        totalTaken: round2(totalTaken),
        sale: sale ? {
            _id: sale._id,
            reference: sale.reference,
            total: sale.total,
            paymentMethod: sale.paymentMethod,
            createdAt: sale.createdAt,
            paymentKind: sale.paymentKind
        } : null
    };

    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Create repair
// @route   POST /api/repairs
// @access  Private
exports.createRepair = asyncHandler(async (req, res) => {
    const { getTenantIdFromReq } = require('../middleware/auth');
    const entitlementsService = require('../services/entitlementsService');
    const platformEntitlementsCache = require('../services/platformEntitlementsCache');
    const platformClient = require('../lib/platformClient');
    const { getLondonMonthRange } = require('../utils/dateKey');
    const tenantId = getTenantIdFromReq(req);
    try {
        await entitlementsService.assertFeature(tenantId, 'repairs');
    } catch (err) {
        return res.status(err.status || 402).json({ success: false, message: err.message || 'Repairs feature is not enabled', code: err.code });
    }
    let proposedRepairsThisMonth;
    if (platformClient.isPlatformConfigured()) {
        const ent = await platformEntitlementsCache.getEntitlements();
        proposedRepairsThisMonth = (ent.usage?.repairsThisMonthUsed ?? 0) + 1;
    } else {
        const { start: monthStart, end: monthEnd } = getLondonMonthRange();
        const repairsThisMonth = await Repair.countDocuments({
            tenantId,
            londonDateKey: { $gte: monthStart, $lte: monthEnd }
        });
        proposedRepairsThisMonth = repairsThisMonth + 1;
    }
    try {
        await entitlementsService.assertLimit(tenantId, 'maxRepairsPerMonth', proposedRepairsThisMonth);
    } catch (err) {
        return res.status(err.status || 402).json({ success: false, message: err.message || 'Repairs per month limit exceeded', code: err.code });
    }
    
    // Phase 3: Location-based access control - validate locationId if provided
    let locationId = req.body.locationId || null;
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0) {
        // Non-admin: must use assigned location or defaultLocationId (if in scope)
        if (locationId) {
            const locationIdStr = locationId.toString ? locationId.toString() : String(locationId);
            if (!userScope.includes(locationIdStr)) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to create repairs for this location'
                });
            }
        } else {
            // Use defaultLocationId if in scope, otherwise use first assigned location
            const defaultLocId = req.user?.defaultLocationId?.toString();
            if (defaultLocId && userScope.includes(defaultLocId)) {
                locationId = defaultLocId;
            } else if (userScope.length > 0) {
                locationId = userScope[0];
            }
        }
    } else if (!locationId && req.user?.defaultLocationId) {
        // Admin or empty assignedLocationIds: use defaultLocationId if available
        locationId = req.user.defaultLocationId;
    }

    // Auto-assign when there is exactly one active location and none was resolved above
    if (!locationId) {
        const Location = require('../models/Location');
        const activeLocations = await Location.find({ tenantId, isActive: true }).select('_id').limit(2).lean();
        if (activeLocations.length === 1) {
            locationId = activeLocations[0]._id;
        }
    }

    const createBody = { ...req.body };
    if (createBody.devices && Array.isArray(createBody.devices)) {
        Object.assign(createBody, syncLegacyFieldsFromDevices(createBody.devices));
    }

    const repair = await Repair.create({
        ...createBody,
        locationId: locationId,
        createdBy: req.user?._id,
        tenantId
    });
    if (platformClient.isPlatformConfigured()) {
        platformClient.postPlatformEvent('REPAIR_CREATED', 1, { repairId: repair._id?.toString(), actorUserId: req.user?._id?.toString() }).catch((e) => console.error('[repairController] Platform event REPAIR_CREATED failed', e.message));
    }

    metricsService.incrementRepairCreated(
        tenantId,
        repair.locationId || null,
        repair.receivedAt || repair.createdAt
    ).catch(() => {});

    await invalidateRepairCaches(tenantId);

    res.status(201).json({
        success: true,
        message: 'Repair created successfully',
        data: repair
    });
});

// @desc    Update repair
// @route   PUT /api/repairs/:id
// @access  Private
exports.updateRepair = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const repairQuery = tenantId === 'default'
        ? { _id: req.params.id, $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] }
        : { _id: req.params.id, tenantId };
    let repair = await Repair.findOne(repairQuery);

    if (!repair) {
        return res.status(404).json({
            success: false,
            message: 'Repair not found'
        });
    }
    
    // Phase 3: Location-based access control - verify user can access this repair's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && repair.locationId) {
        const repairLocationId = repair.locationId.toString ? repair.locationId.toString() : String(repair.locationId);
        if (!userScope.includes(repairLocationId)) {
            return res.status(404).json({
                success: false,
                message: 'Repair not found'
            });
        }
    }
    
    // Phase 3: If update includes locationId, validate it's in allowed locations
    if (req.body.locationId !== undefined) {
        const newLocationId = req.body.locationId;
        if (userScope && userScope.length > 0 && newLocationId) {
            const newLocationIdStr = newLocationId.toString ? newLocationId.toString() : String(newLocationId);
            if (!userScope.includes(newLocationIdStr)) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to assign repairs to this location'
                });
            }
        }
    }

    const update = { ...req.body };
    const oldStatus = repair.status;
    if (update.status === 'completed' && (update.completedAt == null || update.completedAt === '')) {
        update.completedAt = new Date();
    }
    if (update.status === 'collected' && (update.collectedAt == null || update.collectedAt === '')) {
        update.collectedAt = new Date();
    }
    if (update.devices && Array.isArray(update.devices) && update.devices.length > 0) {
        Object.assign(update, syncLegacyFieldsFromDevices(update.devices));
    }

    repair = await Repair.findOneAndUpdate(repairQuery, update, {
        new: true,
        runValidators: true
    })
        .lean();

    if (update.status != null && update.status !== oldStatus) {
        const { getTenantIdFromReq } = require('../middleware/auth');
        const tid = repair?.tenantId || getTenantIdFromReq(req);
        metricsService.repairStatusChange(
            tid,
            repair?.locationId || null,
            oldStatus,
            update.status
        ).catch(() => {});
    }

    const out = repair ? {
        ...repair,
        devices: mapDevicesForApi(repair)
    } : repair;

    await invalidateRepairCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Repair updated successfully',
        data: out
    });
});

// @desc    Take payment or deposit for repair – creates a sale (type: repair) and links to repair (does not set collected)
// @route   POST /api/repairs/:id/take-payment
// @access  Private
exports.takePayment = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const repairQuery = tenantId === 'default'
        ? { _id: req.params.id, $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] }
        : { _id: req.params.id, tenantId };
    const repair = await Repair.findOne(repairQuery);
    if (!repair) {
        return res.status(404).json({ success: false, message: 'Repair not found' });
    }
    
    // Phase 3: Location-based access control - verify user can access this repair's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && repair.locationId) {
        const repairLocationId = repair.locationId.toString ? repair.locationId.toString() : String(repair.locationId);
        if (!userScope.includes(repairLocationId)) {
            return res.status(404).json({ success: false, message: 'Repair not found' });
        }
    }

    const amount = round2(Number(req.body.amount));
    const paymentMethod = (req.body.paymentMethod || 'cash').toLowerCase();
    const isDeposit = req.body.isDeposit === true || req.body.isDeposit === 'true';
    const validMethods = ['cash', 'card', 'credit', 'bank'];
    if (amount == null || amount <= 0 || !validMethods.includes(paymentMethod)) {
        return res.status(400).json({
            success: false,
            message: 'Valid amount (positive number) and paymentMethod (cash, card, credit, bank) are required'
        });
    }

    const amountDue = getRepairAmountDue(repair.toObject ? repair.toObject() : repair);
    const ref = (repair.reference || '').trim() || `Repair ${repair._id}`;
    const itemName = isDeposit ? `Deposit – ${ref}` : `Repair payment – ${ref}`;

    const saleTenantId = repair.tenantId || tenantId || 'default';
    const sale = await Sale.create({
        type: 'repair',
        repairId: repair._id,
        paymentKind: isDeposit ? 'deposit' : 'full',
        locationId: repair.locationId || undefined,
        tenantId: saleTenantId,
        items: [{
            sku: 'REPAIR',
            name: itemName,
            price: amount,
            quantity: 1,
            unit: 'piece'
        }],
        subtotal: amount,
        tax: 0,
        total: amount,
        discount: 0,
        paymentMethod,
        customerId: repair.customerId || undefined,
        customerName: repair.customerName || undefined,
        soldBy: req.user?._id
    });

    let existingIds = Array.isArray(repair.paymentIds) ? repair.paymentIds : [];
    if (existingIds.length === 0 && repair.saleId) {
        existingIds = [repair.saleId];
    }
    const paymentIds = [...existingIds, sale._id];
    await Repair.findByIdAndUpdate(repair._id, {
        saleId: sale._id,
        paymentIds
    });

    metricsService.incrementSaleCreated(
        tenantId,
        sale.locationId || null,
        sale.total,
        sale.occurredAt || sale.createdAt
    ).catch(() => {});

    await invalidateRepairCaches(tenantId);

    res.status(201).json({
        success: true,
        message: isDeposit ? 'Deposit recorded' : 'Payment recorded',
        data: {
            sale: {
                _id: sale._id.toString(),
                reference: sale.reference,
                total: round2(sale.total),
                paymentKind: isDeposit ? 'deposit' : 'full'
            },
            amountDue
        }
    });
});

// @desc    Delete repair
// @route   DELETE /api/repairs/:id
// @access  Private
exports.deleteRepair = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const repairQuery = tenantId === 'default'
        ? { _id: req.params.id, $or: [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }] }
        : { _id: req.params.id, tenantId };
    const repair = await Repair.findOne(repairQuery);

    if (!repair) {
        return res.status(404).json({
            success: false,
            message: 'Repair not found'
        });
    }
    
    // Phase 3: Location-based access control - verify user can access this repair's location
    const userScope = getUserLocationScope(req.user);
    if (userScope && userScope.length > 0 && repair.locationId) {
        const repairLocationId = repair.locationId.toString ? repair.locationId.toString() : String(repair.locationId);
        if (!userScope.includes(repairLocationId)) {
            return res.status(404).json({
                success: false,
                message: 'Repair not found'
            });
        }
    }

    await repair.deleteOne();

    await invalidateRepairCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Repair deleted successfully'
    });
});

// @desc    Typeahead search across previously-used repair item descriptions.
//          Returns unique description+amount combinations, most-recent first, so the
//          edit/add page can autofill price after the technician picks a known service.
// @route   GET /api/repairs/items/search?q=<text>&limit=10
// @access  Private (repair.view or repair.edit)
exports.searchRepairItems = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const q = (req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));

    if (!q) {
        return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const pipeline = [
        { $match: { tenantId } },
        { $unwind: '$repairItems' },
        { $match: { 'repairItems.description': { $regex: regex } } },
        // Most-recent occurrences first so the latest price wins on dedupe.
        { $sort: { updatedAt: -1, createdAt: -1 } },
        {
            // Dedupe by uppercased+trimmed description so "Screen replacement" and "screen replacement " collapse.
            $group: {
                _id: { $toUpper: { $trim: { input: '$repairItems.description' } } },
                description: { $first: '$repairItems.description' },
                amount: { $first: '$repairItems.amount' },
                lastUsedAt: { $first: { $ifNull: ['$updatedAt', '$createdAt'] } }
            }
        },
        { $sort: { lastUsedAt: -1 } },
        { $limit: limit },
        {
            $project: {
                _id: 0,
                description: 1,
                amount: 1,
                lastUsedAt: 1
            }
        }
    ];

    const results = await Repair.aggregate(pipeline);

    res.status(200).json({
        success: true,
        count: results.length,
        data: results
    });
});
