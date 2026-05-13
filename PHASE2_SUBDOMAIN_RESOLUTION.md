# Phase 2: Subdomain-Based Tenant Resolution

## Summary

Implemented subdomain-based tenant resolution where:
- **1 subdomain = 1 tenant**
- Tenant is resolved from request host/subdomain
- All protected APIs use the resolved tenant
- If logged-in `user.tenantId` does not match resolved tenant, access is denied
- Backward compatibility maintained for localhost/dev

---

## Files Changed

### 1. `src/models/Tenant.js`
- **Added**: `subdomain` field (unique, sparse, lowercase, alphanumeric + hyphens, max 63 chars)
- **Added**: Index on `subdomain` field

### 2. `src/middleware/resolveTenant.js` (NEW)
- **`extractSubdomain(host)`**: Extracts subdomain from host header
  - Returns `null` for localhost, IP addresses, reserved subdomains (api, www, admin, etc.)
  - Returns subdomain for valid patterns (e.g., "gnr" from "gnr.inflix.uk")
- **`resolveTenantFromHost(req, res, next)`**: Middleware that:
  - Extracts subdomain from request host
  - Looks up tenant by subdomain (excludes suspended tenants)
  - Sets `req.resolvedTenant = { tenantId, subdomain, status }` or `null`
  - Returns 404 if subdomain not found or tenant is suspended
  - Falls back gracefully for localhost/dev (sets `req.resolvedTenant = null`)

### 3. `src/routes/index.js`
- **Added**: Import `resolveTenantFromHost` middleware
- **Added**: `router.use(resolveTenantFromHost)` before `tenantActiveGate`
  - Runs for all routes (including auth/platform, but won't block if no subdomain)

### 4. `src/middleware/auth.js`
- **Updated**: `getTenantIdFromReq(req)` now:
  1. Prefers `req.resolvedTenant.tenantId` (from subdomain)
  2. Falls back to `req.user.tenantId` (from authenticated user)
  3. Falls back to `'default'` (backward compatibility)
- **Updated**: `protect` middleware now:
  - After loading user, checks if `req.resolvedTenant` exists
  - If resolved tenant exists and `user.tenantId` is set and doesn't match, returns 403 `TENANT_MISMATCH`
  - Allows access if `user.tenantId` is empty/null (legacy users)
  - Allows access if `req.resolvedTenant` is null (localhost/dev)

### 5. `tests/subdomain-tenant-resolution-phase2.test.js` (NEW)
- Tests for `extractSubdomain` function
- Tests for `resolveTenantFromHost` middleware
- Tests for `getTenantIdFromReq` with resolved tenant
- Tests for mismatch protection in `protect` middleware
- Tests for localhost/dev fallback behavior

---

## Behavior

### Localhost/Dev (Backward Compatibility)

**Request**: `http://localhost:5000/api/users` or `http://127.0.0.1:5000/api/users`

1. `resolveTenantFromHost` extracts subdomain → `null` (localhost detected)
2. Sets `req.resolvedTenant = null`
3. `getTenantIdFromReq` falls back to `req.user.tenantId` or `'default'`
4. No mismatch protection (since `req.resolvedTenant` is null)
5. **Result**: Works as before, uses `user.tenantId` or `'default'`

### Production Host/Subdomain

**Request**: `https://gnr.inflix.uk/api/users` (where `gnr` is a tenant subdomain)

1. `resolveTenantFromHost` extracts subdomain → `"gnr"`
2. Looks up tenant: `Tenant.findOne({ subdomain: 'gnr', status: { $ne: 'suspended' } })`
3. If found: Sets `req.resolvedTenant = { tenantId: 'tenant-gnr-id', subdomain: 'gnr', status: 'active' }`
4. If not found: Returns 404 `TENANT_NOT_FOUND`
5. `getTenantIdFromReq` returns `req.resolvedTenant.tenantId` (preferred over `user.tenantId`)
6. `protect` middleware checks:
   - If `user.tenantId` matches `resolvedTenant.tenantId` → Allow
   - If `user.tenantId` is empty/null → Allow (legacy user)
   - If `user.tenantId` doesn't match → Deny with 403 `TENANT_MISMATCH`
7. **Result**: All API calls use the resolved tenant from subdomain

### Mismatch Protection

**Scenario**: User with `tenantId: 'tenant-a'` tries to access `https://tenant-b.inflix.uk/api/users`

1. Subdomain resolves to `tenant-b`
2. `req.resolvedTenant = { tenantId: 'tenant-b' }`
3. `protect` middleware loads user with `tenantId: 'tenant-a'`
4. Mismatch detected → Returns 403:
   ```json
   {
     "success": false,
     "message": "User belongs to tenant 'tenant-a' but subdomain resolves to 'tenant-b'",
     "code": "TENANT_MISMATCH"
   }
   ```

### Suspended Tenant

**Request**: `https://suspended-tenant.inflix.uk/api/users` (where tenant exists but `status: 'suspended'`)

1. `resolveTenantFromHost` looks up tenant (excludes suspended)
2. Tenant not found (because query excludes suspended)
3. Returns 404:
   ```json
   {
     "success": false,
     "message": "Tenant not found for subdomain: suspended-tenant",
     "code": "TENANT_NOT_FOUND"
   }
   ```

---

## Database Migration Notes

The `subdomain` field is:
- **Optional** (sparse index, can be null/empty)
- **Unique** (when set, must be unique across all tenants)
- **Lowercase** (automatically converted)

**To set subdomain for existing tenants:**
```javascript
await Tenant.updateOne(
  { tenantId: 'tenant-id' },
  { $set: { subdomain: 'tenant-slug' } }
);
```

**For new tenants**, set `subdomain` when creating:
```javascript
await Tenant.create({
  tenantId: 'new-tenant-id',
  subdomain: 'new-tenant-slug',
  name: 'New Tenant',
  status: 'active'
});
```

---

## Testing

Run tests:
```bash
cd pos_inflix_backend
npm test -- subdomain-tenant-resolution-phase2.test.js
```

Test coverage:
- ✅ Subdomain extraction (valid, localhost, IPs, reserved, invalid)
- ✅ Tenant resolution (found, not found, suspended)
- ✅ Localhost/dev fallback
- ✅ `getTenantIdFromReq` priority (resolved > user > default)
- ✅ Mismatch protection (match, mismatch, legacy user, localhost)

---

## Next Steps (Phase 3)

Phase 3 will add location-based access control:
- Admins can see all locations in their tenant
- Managers/staff can only see assigned locations
- Location filtering applied to all relevant APIs

Phase 2 is complete and ready for production.
