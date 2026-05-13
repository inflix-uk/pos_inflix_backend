const Location = require('../models/Location');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const LOCATION_CACHE_NAMESPACES = ['locations:list'];
async function invalidateLocationCaches(tenantId) {
    await cache.bumpMany(LOCATION_CACHE_NAMESPACES, tenantId);
}

// @desc    Get all locations
// @route   GET /api/locations
// @access  Private
exports.getLocations = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Location access control: filter by user's location scope (user + role locations)
    const userScope = getUserLocationScope(req.user);

    const params = {
        page, limit,
        type: req.query.type || null,
        isActive: req.query.isActive,
        search: req.query.search || null,
        sort: req.query.sort || null,
        scope: Array.isArray(userScope) ? userScope.map(String).sort() : null
    };

    const payload = await cache.cached(
        { ns: 'locations:list', tenantId, params, ttlSec: TTL.REFERENCE },
        async () => {
            const query = { tenantId };

            // Filter by type
            if (req.query.type) {
                query.type = req.query.type;
            }

            // Filter by active status
            if (req.query.isActive !== undefined) {
                query.isActive = req.query.isActive === 'true';
            }

            if (userScope !== null) {
                query._id = { $in: userScope };
            }

            // Search
            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { contactPerson: { $regex: req.query.search, $options: 'i' } },
                    { city: { $regex: req.query.search, $options: 'i' } },
                    { postcode: { $regex: req.query.search, $options: 'i' } },
                    { email: { $regex: req.query.search, $options: 'i' } }
                ];
            }

            // Sorting
            let sortOption = '-createdAt';
            if (req.query.sort) {
                switch (req.query.sort) {
                    case 'oldest':
                        sortOption = 'createdAt';
                        break;
                    case 'a-z':
                        sortOption = 'name';
                        break;
                    case 'z-a':
                        sortOption = '-name';
                        break;
                    default:
                        sortOption = '-createdAt';
                }
            }

            const [total, locations] = await Promise.all([
                Location.countDocuments(query),
                Location.find(query)
                    .sort(sortOption)
                    .skip(skip)
                    .limit(limit)
                    .lean()
            ]);
            return { total, locations };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.locations.length,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit),
        data: payload.locations
    });
});

// @desc    Get single location
// @route   GET /api/locations/:id
// @access  Private
exports.getLocation = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const location = await Location.findOne({ _id: req.params.id, tenantId });

    if (!location) {
        return res.status(404).json({
            success: false,
            message: 'Location not found'
        });
    }

    res.status(200).json({
        success: true,
        data: location
    });
});

// @desc    Create location
// @route   POST /api/locations
// @access  Private/Admin/Manager
exports.createLocation = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    // Check if name already exists (within tenant)
    const existingName = await Location.findOne({ name: req.body.name, tenantId });
    if (existingName) {
        return res.status(400).json({
            success: false,
            message: 'Location name already exists'
        });
    }

    // Omit empty strings for optional fields so validation doesn't fail
    const body = { ...req.body };
    ['type', 'contactPerson', 'phone', 'email', 'address', 'city', 'postcode', 'country'].forEach((key) => {
        if (body[key] === '' || body[key] == null) delete body[key];
    });
    if (!body.type) body.type = 'store';

    // Check if email already exists within tenant (only when email is provided)
    if (body.email) {
        const existingEmail = await Location.findOne({ email: body.email, tenantId });
        if (existingEmail) {
            return res.status(400).json({
                success: false,
                message: 'Location email already exists'
            });
        }
    }

    const entitlementsService = require('../services/entitlementsService');
    const platformEntitlementsCache = require('../services/platformEntitlementsCache');
    const platformClient = require('../lib/platformClient');
    let proposedLocations;
    if (platformClient.isPlatformConfigured()) {
        const ent = await platformEntitlementsCache.getEntitlements();
        proposedLocations = (ent.usage?.locationsUsed ?? 0) + 1;
    } else {
        proposedLocations = (await Location.countDocuments({ tenantId, isActive: true })) + 1;
    }
    try {
        await entitlementsService.assertLimit(tenantId, 'maxLocations', proposedLocations);
    } catch (err) {
        return res.status(err.status || 402).json({ success: false, message: err.message || 'Location limit exceeded', code: err.code });
    }

    const location = await Location.create({ ...body, tenantId });
    if (platformClient.isPlatformConfigured()) {
        platformClient.postPlatformEvent('LOCATION_CREATED', 1, { locationId: location._id?.toString(), actorUserId: req.user?._id?.toString() }).catch((e) => console.error('[locationController] Platform event LOCATION_CREATED failed', e.message));
    }

    await invalidateLocationCaches(tenantId);
    res.status(201).json({
        success: true,
        message: 'Location created successfully',
        data: location
    });
});

// @desc    Update location
// @route   PUT /api/locations/:id
// @access  Private/Admin/Manager
exports.updateLocation = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    let location = await Location.findOne({ _id: req.params.id, tenantId });

    if (!location) {
        return res.status(404).json({
            success: false,
            message: 'Location not found'
        });
    }

    // If name is being updated, check for duplicates within tenant
    if (req.body.name && req.body.name !== location.name) {
        const existingName = await Location.findOne({
            name: req.body.name,
            tenantId,
            _id: { $ne: req.params.id }
        });
        if (existingName) {
            return res.status(400).json({
                success: false,
                message: 'Location name already exists'
            });
        }
    }

    // Omit empty strings for optional fields so validation doesn't fail
    const body = { ...req.body };
    ['type', 'contactPerson', 'phone', 'email', 'address', 'city', 'postcode', 'country'].forEach((key) => {
        if (body[key] === '' || body[key] == null) delete body[key];
    });
    if (!body.type) body.type = 'store';

    // If email is being updated, check for duplicates within tenant (only when new email is provided)
    if (body.email && body.email !== location.email) {
        const existingEmail = await Location.findOne({
            email: body.email,
            tenantId,
            _id: { $ne: req.params.id }
        });
        if (existingEmail) {
            return res.status(400).json({
                success: false,
                message: 'Location email already exists'
            });
        }
    }

    const wasActive = location.isActive;
    location = await Location.findByIdAndUpdate(req.params.id, body, {
        new: true,
        runValidators: true
    });
    if (wasActive && location && location.isActive === false) {
        const platformClient = require('../lib/platformClient');
        if (platformClient.isPlatformConfigured()) {
            platformClient.postPlatformEvent('LOCATION_ARCHIVED', 1, { locationId: location._id?.toString(), actorUserId: req.user?._id?.toString() }).catch((e) => console.error('[locationController] Platform event LOCATION_ARCHIVED failed', e.message));
        }
    }

    await invalidateLocationCaches(tenantId);
    res.status(200).json({
        success: true,
        message: 'Location updated successfully',
        data: location
    });
});

// @desc    Delete location
// @route   DELETE /api/locations/:id
// @access  Private/Admin
exports.deleteLocation = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const location = await Location.findOne({ _id: req.params.id, tenantId });

    if (!location) {
        return res.status(404).json({
            success: false,
            message: 'Location not found'
        });
    }

    const locationIdStr = location._id?.toString();
    const wasActive = location.isActive;
    await location.deleteOne();

    const platformClient = require('../lib/platformClient');
    if (platformClient.isPlatformConfigured() && wasActive) {
        platformClient.postPlatformEvent('LOCATION_ARCHIVED', 1, { locationId: locationIdStr }).catch((e) => console.error('[locationController] Platform event LOCATION_ARCHIVED failed', e.message));
    }

    await invalidateLocationCaches(tenantId);
    res.status(200).json({
        success: true,
        message: 'Location deleted successfully'
    });
});

// @desc    Get active locations (for dropdown)
// @route   GET /api/locations/active
// @access  Private
exports.getActiveLocations = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const query = { tenantId, isActive: true };
    if (req.query.type) {
        query.type = req.query.type;
    }

    // Location access control: filter by user's location scope (user + role locations)
    const userScope = getUserLocationScope(req.user);
    if (userScope !== null) {
        // User has location restrictions - only show allowed locations
        query._id = { $in: userScope };
    }
    // If userScope is null, user can see all locations (admin or no restrictions)

    const locations = await Location.find(query).sort('name').lean();

    res.status(200).json({
        success: true,
        count: locations.length,
        data: locations
    });
});
