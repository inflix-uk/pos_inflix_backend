# Phase 1 Follow-up: Report Endpoints Without tenantId

## 1. Report endpoints still NOT tenant-safe

All of these use the **Order** model, which has **no `tenantId`** field, so they return data across all tenants:

| Endpoint | Handler | Model | Risk |
|----------|---------|--------|------|
| `GET /api/reports/dashboard` | `getDashboardStats` | Order (today/monthly/yearly aggregates) | Cross-tenant sales/orders |
| `GET /api/reports/sales` | `getSalesReport` | Order | Cross-tenant sales report |
| `GET /api/reports/top-products` | `getTopProducts` | Order | Cross-tenant product performance |
| `GET /api/reports/payment-methods` | `getPaymentMethodReport` | Order | Cross-tenant payment breakdown |
| `GET /api/reports/cashiers` | `getCashierReport` | Order | Cross-tenant cashier stats |

One additional endpoint uses **Sale** and **Repair** but does **not** filter by tenant:

| Endpoint | Handler | Issue |
|----------|---------|--------|
| `GET /api/reports/dashboard/legacy-count` | `getLegacyCount` | Counts Sale/Repair with `locationId: null` globally; no `tenantId` filter (info leak: count only). |

**Already tenant-safe:**  
`GET /api/reports/dashboard/summary`, `GET /api/reports/dashboard/by-location`, `GET /api/reports/takings-dashboard`, `GET /api/reports/inventory` use tenant-scoped models (TenantDailyMetric, LocationDailyMetric, Sale, Repair, Product).

---

## 2. Are the unsafe endpoints used in the current app?

**No.** The frontend does not call any of the Order-based report endpoints.

- **Reports hub** (`/reports`) links only to `/reports/dashboard`, `/reports/takings`, and other non-report-API pages (balance-sheet, trial-balance, etc.).
- **Reports dashboard** (`/reports/dashboard`) uses:
  - `useDashboard` → `fetchDashboard` → **GET /api/dashboard** (main dashboard API; Sale/Repair-based, not reportController).
  - `getByLocation` → **GET /api/reports/dashboard/by-location** (tenant-safe).
  - `getLegacyCount` → **GET /api/reports/dashboard/legacy-count** (used; currently not tenant-scoped).
- **Takings** (`/reports/takings`) uses **GET /api/reports/takings-dashboard** (tenant-safe).

So: **GET /api/reports/dashboard**, **/reports/sales**, **/reports/top-products**, **/reports/payment-methods**, **/reports/cashiers** are **not used** by the app. Only **legacy-count** is used and should be fixed to be tenant-scoped.

---

## 3. Recommended short-term mitigation (before production)

**Preferred: disable unsafe endpoints + fix legacy-count**

- **Disable** the five Order-based report routes so they cannot be called (no frontend impact, removes cross-tenant data exposure).
- **Fix** `getLegacyCount` to filter by `tenantId` so the “legacy records” banner on the Reports dashboard is tenant-scoped.

**Alternative (larger change):** Add `tenantId` to the Order model, backfill, and patch all five handlers. Only do this if you need Order-based reports in the UI later; for now, disabling is the shortest safe path.

---

## 4. Exact files involved

| Action | File |
|--------|------|
| Disable 5 Order-based routes | `pos_inflix_backend/src/routes/reportRoutes.js` |
| Fix legacy-count by tenant | `pos_inflix_backend/src/controllers/reportsDashboardController.js` |
| (Reference) Order-based handlers | `pos_inflix_backend/src/controllers/reportController.js` |
| (Reference) Order model (no tenantId) | `pos_inflix_backend/src/models/Order.js` |

---

## 5. Shortest safe path (summary)

1. In **reportRoutes.js**: Comment out or remove the five routes that use Order-based handlers (`/dashboard` → getDashboardStats, `/sales`, `/top-products`, `/payment-methods`, `/cashiers`). Keep `/dashboard/summary`, `/dashboard/by-location`, `/dashboard/legacy-count`, `/takings-dashboard`, `/inventory`.
2. In **reportsDashboardController.js**: In `getLegacyCount`, get `tenantId` from `getTenantIdFromReq(req)` and add it to the Sale and Repair query (same pattern as Phase 1: for `'default'` include `tenantId` in `['default', null, '']`, else match single `tenantId`).
3. No frontend changes required. No Phase 2 (subdomain) yet.
