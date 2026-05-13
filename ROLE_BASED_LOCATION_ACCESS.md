# Role-Based Location Access Implementation

## Overview
This document describes the implementation of role-based location access control, where roles can have assigned locations and users inherit location access from their assigned roles.

## Changes Made

### Backend

#### 1. Role Model (`src/models/Role.js`)
- Added `assignedLocationIds` field to Role schema
- Roles can now restrict which locations users with that role can access
- Empty/null `assignedLocationIds` means the role does not restrict locations

#### 2. Location Scope Logic (`src/utils/dashboardHelpers.js`)
- Updated `getUserLocationScope()` to merge user's explicit `assignedLocationIds` with locations from assigned roles
- Logic:
  - If user has explicit `assignedLocationIds`, use those (merged with role locations if both exist)
  - If user has no explicit locations but roles have locations, use role locations
  - If neither user nor roles have location assignments, return `null` (all locations)
  - Admin users always return `null` (all locations)

#### 3. RBAC Service (`src/services/rbacService.js`)
- Updated `getPermissionKeysForUser()` to populate roles with `assignedLocationIds`
- Updated `attachPermissionKeys()` to populate `req.user.roles` with location data
- Ensures `getUserLocationScope()` receives populated role data

#### 4. Admin Controller (`src/controllers/adminController.js`)
- Updated `createRole()` to accept and validate `assignedLocationIds`
- Updated `updateRole()` to accept and validate `assignedLocationIds`
- Updated `listRoles()` to populate `assignedLocationIds` in response
- Updated `getRole()` to populate `assignedLocationIds` in response
- Location validation ensures all locations belong to the current tenant

### Frontend

#### 1. Admin API Service (`src/app/(routes)/settings/admin/service/adminApi.ts`)
- Added `assignedLocationIds` to `Role` interface
- Updated `createRole()` payload to accept `assignedLocationIds`
- Updated `updateRole()` payload to accept `assignedLocationIds`

#### 2. Admin Page (`src/app/(routes)/settings/admin/page.tsx`)
- **RoleCreateModal**: Added location assignment UI with checkboxes
- **RoleEditModal**: Added location assignment UI with checkboxes
- **UserUpsertModal**: Added informational section showing which locations are inherited from assigned roles
- Updated help text to explain that user locations are merged with role locations

## How It Works

### Location Access Rules

1. **User with explicit locations**: User's `assignedLocationIds` are used (merged with role locations if both exist)
2. **User with role locations only**: Locations from all assigned roles are merged and used
3. **User with no locations (user or roles)**: Access to all locations (legacy behavior)
4. **Admin users**: Always have access to all locations

### Example Scenarios

**Scenario 1: User with explicit location + role location**
- User has `assignedLocationIds: [loc1]`
- User has Role1 with `assignedLocationIds: [loc2]`
- Result: User can access `[loc1, loc2]` (merged)

**Scenario 2: User with role locations only**
- User has `assignedLocationIds: []` (empty)
- User has Role1 with `assignedLocationIds: [loc1]`
- User has Role2 with `assignedLocationIds: [loc2]`
- Result: User can access `[loc1, loc2]` (from roles)

**Scenario 3: User with role that has no location restrictions**
- User has `assignedLocationIds: []` (empty)
- User has Role3 with `assignedLocationIds: []` (empty)
- Result: User can access all locations (null = no restrictions)

## Testing

A comprehensive test suite has been added in `tests/role-based-location-access.test.js` that verifies:
- `getUserLocationScope()` correctly merges user and role locations
- API enforcement works with role-based locations
- Role CRUD operations handle location assignments correctly

## Migration Notes

- Existing roles will have `assignedLocationIds: []` (no restrictions)
- Existing users continue to work as before
- No database migration required (Mongoose handles new fields gracefully)

## UI Changes

### Role Create/Edit Modals
- Added "Assigned Locations (Optional)" section with checkboxes
- Help text explains that users with the role inherit these locations
- Empty selection means role does not restrict locations

### User Create/Edit Modal
- Added informational section showing location inheritance from roles
- Displays which locations each assigned role provides
- Help text updated to explain merging of user and role locations

## API Changes

### Create Role
```json
POST /api/admin/roles
{
  "name": "Warehouse Staff",
  "description": "Can access warehouse locations",
  "assignedLocationIds": ["loc1_id", "loc2_id"]
}
```

### Update Role
```json
PUT /api/admin/roles/:id
{
  "assignedLocationIds": ["loc1_id"]
}
```

### List Roles
```json
GET /api/admin/roles
// Response includes assignedLocationIds (populated with location names)
```

## Backward Compatibility

- Existing roles without `assignedLocationIds` continue to work (treated as no restrictions)
- Existing users continue to work as before
- Location enforcement logic remains the same, just with additional role-based sources
