# Phase 4: Admin/User Management Alignment - Gap Analysis

## 1. Current User/Admin Management Flow Inspection

### User Creation (`adminController.createUser`)
**Current Issues:**
- ✅ Uses `getTenantIdFromReq(req)` to set tenantId (correct)
- ❌ Does NOT ignore/validate `body.tenantId` from frontend (could be exploited)
- ❌ Does NOT handle `assignedLocationIds` from body
- ❌ Does NOT handle `defaultLocationId` from body
- ❌ No validation that locations belong to same tenant
- ❌ No validation that defaultLocationId is in assignedLocationIds

### User Update (`adminController.updateUser`)
**Current Issues:**
- ❌ Does NOT check tenantId before updating (uses `User.findById` without tenant filter)
- ❌ Does NOT handle `assignedLocationIds` from body
- ❌ Does NOT handle `defaultLocationId` from body
- ❌ Does NOT validate tenantId from body (should ignore it)
- ❌ No validation that locations belong to same tenant
- ❌ No validation that defaultLocationId is in assignedLocationIds

### User Update (`userController.updateUser`)
**Current Issues:**
- ✅ Uses tenant filter in query (correct)
- ❌ Does NOT handle `assignedLocationIds` from body
- ❌ Does NOT handle `defaultLocationId` from body
- ❌ No validation that locations belong to same tenant
- ❌ No validation that defaultLocationId is in assignedLocationIds

### Role Assignment
**Current Status:**
- ✅ `adminController.createUser` accepts `roleIds` array
- ✅ `adminController.updateUser` accepts `roleIds` array
- ✅ Roles are validated as ObjectIds
- ✅ No tenant-specific role assignment (roles are global, which is correct)

### Location Assignment
**Current Status:**
- ❌ `assignedLocationIds` is NOT handled in create/update
- ❌ `defaultLocationId` is NOT handled in create/update
- ❌ No validation that locations belong to current tenant
- ❌ No validation that defaultLocationId is in assignedLocationIds

### Tenant Field Editability
**Current Status:**
- ❌ `body.tenantId` is NOT explicitly ignored/rejected in tenant app
- ❌ Frontend could potentially send `tenantId` in body (security risk)
- ❌ No validation that user being edited belongs to current tenant (in updateUser)

---

## 2. Rules to Implement

### Rule 1: Tenant Enforcement
- **Create**: Always use `getTenantIdFromReq(req)` (from resolved tenant or user.tenantId)
- **Update**: Verify user belongs to current tenant before updating
- **Body.tenantId**: Explicitly ignore/delete `body.tenantId` if present (never trust frontend)

### Rule 2: Location Assignment
- **assignedLocationIds**: Accept array of location IDs from body
- **Validation**: All locations must belong to current tenant
- **Validation**: Reject cross-tenant location assignments
- **defaultLocationId**: Accept from body
- **Validation**: `defaultLocationId` must be in `assignedLocationIds` (if assignedLocationIds is non-empty)
- **Exception**: If `assignedLocationIds` is empty/null, allow any `defaultLocationId` in tenant (legacy behavior)

### Rule 3: Location Integrity
- **Empty assignedLocationIds**: Preserve as "all locations" (backward compatibility)
- **Non-empty assignedLocationIds**: Enforce that defaultLocationId is in the set
- **Cross-tenant locations**: Reject with 400 error

---

## 3. StockTransfer Location Enforcement (Phase 3 Follow-up)

### Current Status
- ✅ Has `fromLocationId` and `toLocationId` (both required)
- ✅ Tenant filtering present
- ❌ No location-based access control (user can see transfers from/to any location in tenant)
- ❌ No validation that user can access fromLocationId/toLocationId

### Rules to Add
- **List**: Filter by user's assigned locations (fromLocationId OR toLocationId in scope)
- **Get-By-ID**: Verify user can access fromLocationId OR toLocationId
- **Create**: Validate user can access both fromLocationId AND toLocationId
- **Update**: Validate user can access both fromLocationId AND toLocationId (if changed)
- **Dispatch/Receive**: Verify user can access relevant location

---

## 4. Frontend Admin UI Inspection Needed

**To Check:**
- Does user create/edit form send `tenantId`?
- Does user create/edit form handle `assignedLocationIds`?
- Does user create/edit form handle `defaultLocationId`?
- Is there a tenant selector in tenant app (should not exist)?

---

## 5. Files to Change

### Backend
1. `src/controllers/adminController.js` - createUser, updateUser
2. `src/controllers/userController.js` - updateUser (if needed)
3. `src/controllers/stockTransferController.js` - Add location enforcement

### Frontend (if needed)
- User create/edit forms in admin settings

### Tests
- `tests/user-management-phase4.test.js` (NEW)

---

## 6. Test Cases Needed

1. ✅ User creation always uses current tenant (body.tenantId ignored)
2. ✅ User update verifies user belongs to current tenant
3. ✅ Cross-tenant location assignment rejected
4. ✅ defaultLocationId outside assignedLocationIds rejected (when assignedLocationIds non-empty)
5. ✅ StockTransfer location enforcement
6. ✅ Empty assignedLocationIds preserves "all locations" behavior
