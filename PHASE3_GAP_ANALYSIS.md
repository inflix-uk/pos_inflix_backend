# Phase 3: Location-Based Access Control - Gap Analysis

## A. Classification: Tenant-Wide vs Location-Scoped

### Tenant-Wide Only (No location filtering needed)
- **users** (`userController.js`, `adminController.js`) - Tenant-scoped only
- **customers** (`customerController.js`) - Tenant-scoped only
- **products** (`productController.js`) - Product catalog is tenant-wide
- **categories/subcategories** - Master data, tenant-wide
- **suppliers** - Tenant-wide
- **pricing groups** - Tenant-wide
- **settings** (about, notes-terms, bank-accounts, email, taxes, inventory, general, printing) - Tenant-wide
- **roles/permissions** - Global (shared across tenants)
- **locations** (`locationController.js`) - Location list itself is tenant-wide (but users see only assigned)

### Location-Scoped (Requires location filtering)
- **sales** (`salesController.js`) - Has `locationId` field, needs enforcement
- **repairs** (`repairController.js`) - Has `locationId` field, needs enforcement
- **dashboard** (`dashboardController.js`) - ✅ **Already enforced** (uses `getUserLocationScope` + `getLocationFilter`)
- **reports** (`reportController.js`, `reportsDashboardController.js`) - ✅ **Already enforced** (uses `getUserLocationScope`)
- **purchases** - Need to check if has `locationId`
- **sales returns** - Need to check if has `locationId`
- **stock transfers** - Likely location-scoped (from/to locations)
- **stock adjustments** - Likely location-scoped
- **inventory by location** - Need to check
- **expenses** - Need to check if location-scoped
- **activity log** - Already tenant-scoped, may need location filtering for location-scoped events

---

## B. Current Implementation Status

### ✅ Already Enforced (Location Filtering Present)

#### 1. `dashboardController.js`
- **Status**: ✅ Fully enforced
- **Implementation**: Uses `getUserLocationScope(req.user)` and `getLocationFilter(req.query, userScope)`
- **Methods**: `getDashboard` - filters Sale, Repair, Product queries by location scope
- **Access Rules**: Admin sees all locations, others see only assigned locations

#### 2. `reportsDashboardController.js`
- **Status**: ✅ Fully enforced
- **Implementation**: Uses `getUserLocationScope(req.user)` for `getSummary`, `getByLocation`
- **Methods**: `getSummary`, `getByLocation` - filters LocationDailyMetric/TenantDailyMetric by location scope
- **Access Rules**: Admin sees all locations, others see only assigned locations

### ❌ Missing Enforcement (Location Filtering Needed)

#### 1. `salesController.js`
- **Status**: ❌ Missing location enforcement
- **Current**: Only tenant filtering (`tenantId`)
- **Methods needing enforcement**:
  - `getSales` - List sales (no location filter)
  - `getSaleById` - Get single sale (no location check)
  - `createSale` - Create sale (no location validation)
  - `updateSale` - Update sale (no location check)
  - `voidSale` - Void sale (no location check)
  - `hardDeleteSale` - Hard delete (no location check)
  - `getSoldSerials` - Sold serials (no location filter)
- **Model**: `Sale` has `locationId` field ✅

#### 2. `repairController.js`
- **Status**: ❌ Missing location enforcement
- **Current**: Only tenant filtering (`tenantId`)
- **Methods needing enforcement**:
  - `getRepairs` - List repairs (no location filter)
  - `getRepair` - Get single repair (no location check)
  - `createRepair` - Create repair (no location validation)
  - `updateRepair` - Update repair (no location check)
  - `deleteRepair` - Delete repair (no location check)
  - `takePayment` - Take payment (no location check)
- **Model**: `Repair` has `locationId` field ✅

#### 3. Other Controllers (To Inspect)
- **purchaseController.js** - Need to check if purchases are location-scoped
- **salesReturnController.js** - Need to check if returns are location-scoped
- **stockTransferController.js** - Likely location-scoped (from/to locations)
- **stockAdjustmentController.js** - Likely location-scoped
- **expenseController.js** - Need to check if expenses are location-scoped
- **inventoryController.js** - Need to check inventory queries

---

## C. Access Rules to Implement

### For Admin Users (`role === 'admin'`)
- **Access**: All locations in current tenant
- **Implementation**: `getUserLocationScope` returns `null` (all locations)
- **Filter**: No location filter applied (or `locationId: { $in: allTenantLocationIds }`)

### For Non-Admin Users (managers/staff)
- **Access**: Only locations in `assignedLocationIds`
- **Implementation**: `getUserLocationScope` returns array of location ID strings
- **Filter**: `locationId: { $in: allowedLocationIds }` or `locationId: allowedLocationId` for single

### For Users with Empty `assignedLocationIds`
- **Current behavior**: `getUserLocationScope` returns `null` (all locations) if `assignedLocationIds` is empty/null
- **Decision**: **Preserve this behavior** for backward compatibility
- **Note**: This means users without assigned locations can see all locations (may need migration later)

### For Create/Update Actions
- **Validation**: User cannot create/update records for locations outside `assignedLocationIds`
- **Check**: If `body.locationId` is provided, validate it's in allowed locations
- **Default**: If `body.locationId` is null/undefined, use `defaultLocationId` (if in allowed locations) or first allowed location

### For Get/List Actions
- **Filter**: Apply location filter to queries
- **Implementation**: Use `getUserLocationScope` to get allowed locations, then filter queries

### For Get-By-ID Actions
- **Check**: After loading record, verify `record.locationId` is in allowed locations
- **Response**: Return 404 if location is outside scope (don't reveal existence)

---

## D. Helper Functions Available

### `getUserLocationScope(user)` (from `utils/dashboardHelpers.js`)
- **Returns**: 
  - `null` if admin or `assignedLocationIds` is empty/null (all locations)
  - `string[]` of location ID strings if non-admin with assigned locations
- **Usage**: Already used in dashboard and reports

### `getLocationFilter(query, userScope)` (from `dashboardController.js`)
- **Returns**: MongoDB query object for location filtering
- **Handles**: Single `locationId`, multiple `locationIds`, "unknown" location, user scope fallback
- **Usage**: Currently only in dashboard, can be reused

---

## E. Implementation Plan

### Phase 3.1: Sales Controller
1. Import `getUserLocationScope` from `utils/dashboardHelpers`
2. Add location filter to `getSales` query
3. Add location check to `getSaleById` (404 if outside scope)
4. Add location validation to `createSale` (block if locationId not in allowed)
5. Add location check to `updateSale`, `voidSale`, `hardDeleteSale`
6. Add location filter to `getSoldSerials` if needed

### Phase 3.2: Repair Controller
1. Import `getUserLocationScope` from `utils/dashboardHelpers`
2. Add location filter to `getRepairs` query
3. Add location check to `getRepair` (404 if outside scope)
4. Add location validation to `createRepair` (block if locationId not in allowed)
5. Add location check to `updateRepair`, `deleteRepair`, `takePayment`

### Phase 3.3: Other Location-Scoped Controllers
1. Inspect purchase, sales return, stock transfer, stock adjustment, expense controllers
2. Apply same pattern if they have `locationId` field
3. Document which are location-scoped vs tenant-wide

### Phase 3.4: Testing
1. Test admin can access all locations
2. Test manager/staff can access only assigned locations
3. Test get-by-id returns 404 for out-of-scope records
4. Test create/update blocks out-of-scope locationId
5. Test dashboard/reports remain location-scoped

---

## F. Files to Change

### Core Implementation
- `src/controllers/salesController.js` - Add location enforcement
- `src/controllers/repairController.js` - Add location enforcement
- `src/utils/dashboardHelpers.js` - Already has `getUserLocationScope` ✅
- `src/controllers/dashboardController.js` - Already enforced ✅
- `src/controllers/reportsDashboardController.js` - Already enforced ✅

### Potential Additional Files (To Inspect)
- `src/controllers/purchaseController.js`
- `src/controllers/salesReturnController.js`
- `src/controllers/stockTransferController.js`
- `src/controllers/stockAdjustmentController.js`
- `src/controllers/expenseController.js`
- `src/controllers/inventoryController.js`

### Testing
- `tests/location-access-control-phase3.test.js` (NEW)

---

## G. Remaining Gaps After Phase 3

### Known Gaps (To Address Later)
1. **Users with empty `assignedLocationIds`** - Currently see all locations (may need migration)
2. **Other location-scoped controllers** - Need inspection and patching if they exist
3. **Activity log location filtering** - May need location filter for location-scoped events

### Out of Scope for Phase 3
- Frontend changes
- Subdomain/tenant logic changes
- Tenant-wide model changes
- Location assignment UI changes
