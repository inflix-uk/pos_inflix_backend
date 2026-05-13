# Phase 4: Admin/User Management Alignment

## Summary

Phase 4 aligns user creation and editing with the tenant + location model, ensuring:
- Users created in tenant app always belong to the current resolved tenant
- `body.tenantId` is never trusted from frontend
- Location assignments are validated to belong to the same tenant
- `defaultLocationId` must be within `assignedLocationIds` (when non-empty)
- StockTransfer controller enforces location-based access control

---

## A. Gap Analysis

### Issues Identified

1. **Tenant Enforcement**
   - ❌ `adminController.createUser` did not explicitly ignore `body.tenantId`
   - ❌ `adminController.updateUser` did not verify user belongs to current tenant
   - ❌ `adminController.resetUserPassword` and `deleteUser` did not verify tenant

2. **Location Assignment**
   - ❌ `assignedLocationIds` and `defaultLocationId` were not handled in create/update
   - ❌ No validation that locations belong to current tenant
   - ❌ No validation that `defaultLocationId` is in `assignedLocationIds`

3. **StockTransfer Location Enforcement (Phase 3 Follow-up)**
   - ❌ No location-based access control in `stockTransferController`
   - ❌ Users could see/create transfers for any location in tenant

---

## B. Exact Files Changed

### Backend Controllers

1. **`src/controllers/adminController.js`**
   - Added `Location` model import
   - Added `validateLocationsInTenant` helper function
   - Updated `createUser`:
     - Ignores `body.tenantId` (always uses `getTenantIdFromReq(req)`)
     - Accepts and validates `assignedLocationIds`
     - Accepts and validates `defaultLocationId`
     - Validates locations belong to current tenant
     - Validates `defaultLocationId` is in `assignedLocationIds` (when non-empty)
   - Updated `updateUser`:
     - Verifies user belongs to current tenant before updating
     - Ignores `body.tenantId`
     - Handles `assignedLocationIds` and `defaultLocationId` updates
     - Validates location assignments
   - Updated `resetUserPassword`:
     - Verifies user belongs to current tenant
   - Updated `deleteUser`:
     - Verifies user belongs to current tenant

2. **`src/controllers/stockTransferController.js`**
   - Added `getUserLocationScope` import from `dashboardHelpers`
   - Updated `list`:
     - Filters transfers by user's assigned locations (fromLocationId OR toLocationId in scope)
   - Updated `getById`:
     - Returns 404 if user cannot access fromLocationId OR toLocationId
   - Updated `create`:
     - Validates user can access both fromLocationId AND toLocationId
   - Updated `update`:
     - Verifies user can access current transfer
     - Validates new locations if changed
   - Updated `dispatch`:
     - Verifies user can access fromLocationId
   - Updated `receive`:
     - Verifies user can access toLocationId

### Tests

3. **`tests/user-management-phase4.test.js`** (NEW)
   - Tests tenant enforcement in user creation
   - Tests location assignment validation
   - Tests cross-tenant location rejection
   - Tests `defaultLocationId` validation
   - Tests StockTransfer location enforcement

### Documentation

4. **`PHASE4_GAP_ANALYSIS.md`** (NEW)
   - Detailed gap analysis of current vs. target state

5. **`PHASE4_USER_MANAGEMENT_ALIGNMENT.md`** (THIS FILE)
   - Implementation summary and rules

---

## C. Rules Implemented

### Rule 1: Tenant Enforcement

**Create User:**
- Always uses `getTenantIdFromReq(req)` (from resolved tenant or `user.tenantId`)
- Explicitly ignores `body.tenantId` if present
- New user's `tenantId` is set from resolved tenant, never from request body

**Update User:**
- Verifies user belongs to current tenant using `User.findOne({ _id, tenantId })`
- Returns 404 if user not found in current tenant
- Ignores `body.tenantId` if present

**Delete/Reset Password:**
- Verifies user belongs to current tenant before operation

### Rule 2: Location Assignment

**Create User:**
- Accepts `assignedLocationIds` array from body
- Validates all locations belong to current tenant
- Rejects cross-tenant location assignments with 400 error
- Accepts `defaultLocationId` from body
- If `assignedLocationIds` is non-empty, validates `defaultLocationId` is in the set
- If `assignedLocationIds` is empty/null, allows any `defaultLocationId` in tenant (legacy behavior)

**Update User:**
- Accepts `assignedLocationIds` update (array or empty array)
- Validates all locations belong to current tenant
- Accepts `defaultLocationId` update (including null to clear)
- Validates `defaultLocationId` is in `assignedLocationIds` (when non-empty)
- Validates `defaultLocationId` belongs to current tenant

### Rule 3: Location Integrity

**Empty `assignedLocationIds`:**
- Preserved as "all locations" (backward compatibility)
- Allows any `defaultLocationId` in tenant
- Documented as legacy behavior

**Non-empty `assignedLocationIds`:**
- Enforces that `defaultLocationId` must be in the set
- All locations must belong to the same tenant
- Cross-tenant locations rejected with 400 error

### Rule 4: StockTransfer Location Enforcement

**List:**
- Admin: sees all transfers in tenant
- Non-admin: sees transfers where fromLocationId OR toLocationId is in assigned locations

**Get-By-ID:**
- Admin: can access any transfer in tenant
- Non-admin: returns 404 if neither fromLocationId nor toLocationId is in assigned locations

**Create:**
- Admin: can create transfers between any locations in tenant
- Non-admin: must have access to both fromLocationId AND toLocationId

**Update:**
- Admin: can update any transfer in tenant
- Non-admin: must have access to current transfer AND new locations (if changed)

**Dispatch:**
- Admin: can dispatch from any location
- Non-admin: must have access to fromLocationId

**Receive:**
- Admin: can receive to any location
- Non-admin: must have access to toLocationId

---

## D. Remaining Legacy Behavior

### Empty `assignedLocationIds` = "All Locations"

**Current Behavior:**
- Users with empty/null `assignedLocationIds` can access all locations in their tenant
- This is preserved for backward compatibility

**Rationale:**
- Legacy users may not have location assignments
- Empty `assignedLocationIds` is treated as "admin-like" access within tenant
- `defaultLocationId` can be set to any location in tenant when `assignedLocationIds` is empty

**Future Consideration:**
- Consider requiring location assignments for new users
- Consider migration to assign all locations to legacy users explicitly
- Document this behavior clearly in user management UI

---

## E. Final Diff Summary

### adminController.js

**Added:**
- `Location` model import
- `validateLocationsInTenant` helper function (validates locations belong to tenant)

**createUser:**
- Extracts `assignedLocationIds` and `defaultLocationId` from body
- Validates locations belong to tenant
- Validates `defaultLocationId` is in `assignedLocationIds` (when non-empty)
- Sets location fields on user creation
- Ignores `body.tenantId` (always uses resolved tenant)

**updateUser:**
- Verifies user belongs to current tenant (`User.findOne({ _id, tenantId })`)
- Handles `assignedLocationIds` update (array or empty)
- Handles `defaultLocationId` update (including null)
- Validates location assignments
- Ignores `body.tenantId`

**resetUserPassword:**
- Verifies user belongs to current tenant

**deleteUser:**
- Verifies user belongs to current tenant

### stockTransferController.js

**Added:**
- `getUserLocationScope` import from `dashboardHelpers`

**list:**
- Filters by user's assigned locations (fromLocationId OR toLocationId in scope)

**getById:**
- Returns 404 if user cannot access fromLocationId OR toLocationId

**create:**
- Validates user can access both fromLocationId AND toLocationId

**update:**
- Verifies user can access current transfer
- Validates new locations if changed

**dispatch:**
- Verifies user can access fromLocationId

**receive:**
- Verifies user can access toLocationId

### Tests

**user-management-phase4.test.js (NEW):**
- 10+ test cases covering:
  - Tenant enforcement in create/update
  - Location assignment validation
  - Cross-tenant location rejection
  - `defaultLocationId` validation
  - StockTransfer location enforcement

---

## F. Remaining Gaps After Phase 4

### Frontend UI (Not Addressed)

**Current Status:**
- Frontend user management forms were not found/inspected
- Backend is secure and will reject invalid requests

**Recommendation:**
- When frontend user management UI is built, ensure:
  - No `tenantId` field in create/edit forms
  - Location selector shows only locations in current tenant
  - `defaultLocationId` selector shows only locations in `assignedLocationIds` (when non-empty)
  - Clear indication of "all locations" when `assignedLocationIds` is empty

### Platform Tenant Creation

**Current Status:**
- Platform tenant creation already handles `subdomain` (from Phase 2)
- No changes needed in Phase 4

---

## Testing

Run Phase 4 tests:
```bash
cd pos_inflix_backend
npm test -- user-management-phase4.test.js
```

All tests should pass, validating:
- ✅ Tenant enforcement in user creation/editing
- ✅ Location assignment validation
- ✅ Cross-tenant location rejection
- ✅ `defaultLocationId` integrity
- ✅ StockTransfer location enforcement

---

## Next Steps

Phase 4 is complete. The system now has:
- ✅ Secure tenant enforcement in user management
- ✅ Location assignment validation
- ✅ StockTransfer location-based access control

**Optional Future Enhancements:**
- Frontend UI updates for location assignment
- Migration script to assign locations to legacy users
- Admin UI to visualize user location assignments
