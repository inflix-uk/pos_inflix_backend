/**
 * Tests for role-based location access control.
 * Verifies that:
 * - Roles can have assignedLocationIds
 * - Users inherit location access from their roles
 * - getUserLocationScope merges user and role locations correctly
 * - Location enforcement works with role-based access
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Location = require('../src/models/Location');
const Tenant = require('../src/models/Tenant');
const Sale = require('../src/models/Sale');
const { getUserLocationScope } = require('../src/utils/dashboardHelpers');

let mongoServer;
let tenant1, tenant2;
let loc1, loc2, loc3, loc4; // loc1-2 in tenant1, loc3-4 in tenant2
let role1, role2, role3; // role1: loc1, role2: loc2, role3: no locations
let user1, user2, user3, user4; // user1: explicit loc1, user2: role1 (loc1), user3: role1+role2 (loc1+loc2), user4: role3 (no restrictions)

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    
    // Create tenants
    tenant1 = await Tenant.create({ name: 'Tenant 1', subdomain: 'tenant1', isActive: true });
    tenant2 = await Tenant.create({ name: 'Tenant 2', subdomain: 'tenant2', isActive: true });
    
    // Create locations
    loc1 = await Location.create({ name: 'Location 1', tenantId: tenant1._id, isActive: true });
    loc2 = await Location.create({ name: 'Location 2', tenantId: tenant1._id, isActive: true });
    loc3 = await Location.create({ name: 'Location 3', tenantId: tenant2._id, isActive: true });
    loc4 = await Location.create({ name: 'Location 4', tenantId: tenant2._id, isActive: true });
    
    // Create roles
    role1 = await Role.create({ name: 'Role1', description: 'Has Location 1', assignedLocationIds: [loc1._id] });
    role2 = await Role.create({ name: 'Role2', description: 'Has Location 2', assignedLocationIds: [loc2._id] });
    role3 = await Role.create({ name: 'Role3', description: 'No location restrictions', assignedLocationIds: [] });
    
    // Create users
    user1 = await User.create({
        name: 'User 1',
        email: 'user1@test.com',
        password: 'Test123!@#',
        tenantId: tenant1._id,
        role: 'staff',
        roles: [],
        assignedLocationIds: [loc1._id], // Explicit assignment
        isActive: true
    });
    
    user2 = await User.create({
        name: 'User 2',
        email: 'user2@test.com',
        password: 'Test123!@#',
        tenantId: tenant1._id,
        role: 'staff',
        roles: [role1._id], // Inherits loc1 from role1
        assignedLocationIds: [], // No explicit assignment
        isActive: true
    });
    
    user3 = await User.create({
        name: 'User 3',
        email: 'user3@test.com',
        password: 'Test123!@#',
        tenantId: tenant1._id,
        role: 'staff',
        roles: [role1._id, role2._id], // Inherits loc1 from role1 and loc2 from role2
        assignedLocationIds: [], // No explicit assignment
        isActive: true
    });
    
    user4 = await User.create({
        name: 'User 4',
        email: 'user4@test.com',
        password: 'Test123!@#',
        tenantId: tenant1._id,
        role: 'staff',
        roles: [role3._id], // Role3 has no location restrictions
        assignedLocationIds: [], // No explicit assignment
        isActive: true
    });
});

describe('Role-based location access', () => {
    describe('getUserLocationScope', () => {
        it('should return user explicit locations when user has assignedLocationIds', async () => {
            // Populate roles for user1
            const u1 = await User.findById(user1._id).populate({ 
                path: 'roles', 
                populate: { path: 'assignedLocationIds' }
            }).lean();
            
            const scope = getUserLocationScope(u1);
            expect(scope).toEqual([loc1._id.toString()]);
        });
        
        it('should return role locations when user has no explicit assignments', async () => {
            // Populate roles for user2
            const u2 = await User.findById(user2._id).populate({ 
                path: 'roles', 
                populate: { path: 'assignedLocationIds' }
            }).lean();
            
            const scope = getUserLocationScope(u2);
            expect(scope).toEqual([loc1._id.toString()]);
        });
        
        it('should merge locations from multiple roles', async () => {
            // Populate roles for user3
            const u3 = await User.findById(user3._id).populate({ 
                path: 'roles', 
                populate: { path: 'assignedLocationIds' }
            }).lean();
            
            const scope = getUserLocationScope(u3);
            expect(scope).toHaveLength(2);
            expect(scope).toContain(loc1._id.toString());
            expect(scope).toContain(loc2._id.toString());
        });
        
        it('should merge user explicit locations with role locations', async () => {
            // Create user with explicit loc2 and role1 (loc1)
            const user5 = await User.create({
                name: 'User 5',
                email: 'user5@test.com',
                password: 'Test123!@#',
                tenantId: tenant1._id,
                role: 'staff',
                roles: [role1._id],
                assignedLocationIds: [loc2._id], // Explicit loc2
                isActive: true
            });
            
            const u5 = await User.findById(user5._id).populate({ 
                path: 'roles', 
                populate: { path: 'assignedLocationIds' }
            }).lean();
            
            const scope = getUserLocationScope(u5);
            expect(scope).toHaveLength(2);
            expect(scope).toContain(loc1._id.toString());
            expect(scope).toContain(loc2._id.toString());
        });
        
        it('should return null when user and roles have no location restrictions', async () => {
            // Populate roles for user4
            const u4 = await User.findById(user4._id).populate({ 
                path: 'roles', 
                populate: { path: 'assignedLocationIds' }
            }).lean();
            
            const scope = getUserLocationScope(u4);
            expect(scope).toBeNull(); // No restrictions = all locations
        });
        
        it('should return null for admin users', async () => {
            const admin = await User.create({
                name: 'Admin',
                email: 'admin@test.com',
                password: 'Test123!@#',
                tenantId: tenant1._id,
                role: 'admin',
                roles: [],
                assignedLocationIds: [],
                isActive: true
            });
            
            const scope = getUserLocationScope(admin);
            expect(scope).toBeNull();
        });
    });
    
    describe('API enforcement with role-based locations', () => {
        let user2Token, user3Token, user4Token;
        
        beforeEach(async () => {
            // Login users to get tokens
            const res2 = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user2@test.com', password: 'Test123!@#' });
            user2Token = res2.body.token;
            
            const res3 = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user3@test.com', password: 'Test123!@#' });
            user3Token = res3.body.token;
            
            const res4 = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user4@test.com', password: 'Test123!@#' });
            user4Token = res4.body.token;
            
            // Create sales for testing
            await Sale.create([
                { tenantId: tenant1._id, locationId: loc1._id, total: 100, status: 'completed' },
                { tenantId: tenant1._id, locationId: loc2._id, total: 200, status: 'completed' }
            ]);
        });
        
        it('should allow user2 (role1=loc1) to see sales from loc1 only', async () => {
            const res = await request(app)
                .get('/api/sales')
                .set('Authorization', `Bearer ${user2Token}`)
                .set('Host', 'tenant1.localhost');
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].locationId.toString()).toBe(loc1._id.toString());
        });
        
        it('should allow user3 (role1+role2) to see sales from loc1 and loc2', async () => {
            const res = await request(app)
                .get('/api/sales')
                .set('Authorization', `Bearer ${user3Token}`)
                .set('Host', 'tenant1.localhost');
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(2);
            const locationIds = res.body.data.map((s) => s.locationId.toString());
            expect(locationIds).toContain(loc1._id.toString());
            expect(locationIds).toContain(loc2._id.toString());
        });
        
        it('should allow user4 (role3=no restrictions) to see all sales', async () => {
            const res = await request(app)
                .get('/api/sales')
                .set('Authorization', `Bearer ${user4Token}`)
                .set('Host', 'tenant1.localhost');
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(2);
        });
    });
    
    describe('Role CRUD with locations', () => {
        let adminToken;
        
        beforeEach(async () => {
            const admin = await User.create({
                name: 'Admin',
                email: 'admin@test.com',
                password: 'Test123!@#',
                tenantId: tenant1._id,
                role: 'admin',
                roles: [],
                isActive: true
            });
            
            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'admin@test.com', password: 'Test123!@#' });
            adminToken = res.body.token;
        });
        
        it('should create role with location assignments', async () => {
            const res = await request(app)
                .post('/api/admin/roles')
                .set('Authorization', `Bearer ${adminToken}`)
                .set('Host', 'tenant1.localhost')
                .send({
                    name: 'NewRole',
                    description: 'Test role',
                    assignedLocationIds: [loc1._id.toString(), loc2._id.toString()]
                });
            
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.assignedLocationIds).toHaveLength(2);
            
            // Verify in DB
            const role = await Role.findById(res.body.data._id).populate('assignedLocationIds').lean();
            expect(role.assignedLocationIds).toHaveLength(2);
        });
        
        it('should update role location assignments', async () => {
            const res = await request(app)
                .put(`/api/admin/roles/${role1._id}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .set('Host', 'tenant1.localhost')
                .send({
                    assignedLocationIds: [loc2._id.toString()]
                });
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            
            // Verify in DB
            const role = await Role.findById(role1._id).populate('assignedLocationIds').lean();
            expect(role.assignedLocationIds).toHaveLength(1);
            expect(role.assignedLocationIds[0]._id.toString()).toBe(loc2._id.toString());
        });
        
        it('should list roles with location assignments', async () => {
            const res = await request(app)
                .get('/api/admin/roles')
                .set('Authorization', `Bearer ${adminToken}`)
                .set('Host', 'tenant1.localhost');
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            const role1Data = res.body.data.find((r) => r._id === role1._id.toString());
            expect(role1Data.assignedLocationIds).toHaveLength(1);
            expect(role1Data.assignedLocationIds[0]._id || role1Data.assignedLocationIds[0]).toBe(loc1._id.toString());
        });
    });
});
