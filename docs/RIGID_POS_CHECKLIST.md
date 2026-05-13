# Rigid POS – Wholesale & Inventory Integrity Checklist

This document tracks data integrity, atomicity, auditability, and security measures for the POS system. **MongoDB** is used (no SQL foreign keys); referential integrity and constraints are enforced at the application layer and via schema validators/indexes.

---

## 1. Data Integrity (DB / Schema Level)

| Area | Implementation | Status |
|------|----------------|--------|
| **References (FK-like)** | All relationships use `ref` in Mongoose (Sale → Customer, LedgerEntry → Customer/Supplier, SoldSerial → Sale/SalesReturn). Controllers validate existence where required. | ✅ |
| **NOT NULL / defaults** | Required fields on Sale, SalesReturn, LedgerEntry, SoldSerial; defaults on optional fields (e.g. `min: 0` for payments, `default: 0`). | ✅ |
| **CHECK-like constraints** | Sale/SaleItem: `price >= 0`, `quantity >= 1`, `subtotal/total >= 0`. SalesReturn items: `netUnitPrice/subtotal >= 0`, `quantity >= 1`. Payment breakdown: `min: 0`. | ✅ |
| **Unique indexes** | Sale: `reference` unique. SoldSerial: `serialNumber` unique. SalesReturn: `reference` unique sparse. | ✅ |
| **Double-return prevention** | Unique on `serialNumber` in SoldSerial; return flow uses `findOneAndUpdate({ serialNumber, status: 'sold' }, ...)` so only one return wins per serial. | ✅ |

---

## 2. Atomic Transactions (No Partial Saves)

| Operation | Implementation | Status |
|-----------|----------------|--------|
| **Create Sale** | `transactionService.runWithTransaction` + `salesTransactionService.createSaleInTransaction`. Sale, SoldSerials, LedgerEntries, Customer balance, SerialHistory, Product/Purchase decrements in one transaction. Audit log written after commit. | ✅ |
| **Create Sales Return** | Same pattern. SalesReturn, LedgerEntry (store credit/refund), Customer balance, SoldSerial updates (findOneAndUpdate per serial), SerialHistory, Product restock in one transaction. Audit after commit. | ✅ |
| **Edit Sale** | Currently not wrapped in transaction; ledger and inventory updates are applied sequentially. Recommendation: future work to wrap in `runWithTransaction`. | ⚠️ Documented |
| **Edit Return / Refund** | Same as edit sale; audit log present, transaction wrap optional for future. | ⚠️ Documented |

**Note:** MongoDB must be running as a **replica set** for multi-document transactions. Single-node replica set is sufficient for development.

---

## 3. Never Silently Rewrite History (Rigid Accounting)

| Rule | Implementation | Status |
|------|----------------|--------|
| **Payments immutable** | Original `payment_in` ledger entries for a sale are **never deleted**. When payment breakdown is edited, a **new** ledger entry is created: "Payment adjustment - INV-xxx" with the delta; customer balance updated accordingly. | ✅ |
| **Sale total corrections** | Original `sale` ledger entry is **not** updated. When invoice total changes, a **new** ledger entry is created: "Invoice adjustment - INV-xxx" with the amount delta. | ✅ |
| **Inventory ledger-style** | Product quantity is still updated via increment/decrement. Full ledger-based stock (StockMove IN/OUT/ADJUST/RETURN) can be added in a future phase. | ⚠️ Documented |

---

## 4. Concurrency Safety

| Scenario | Implementation | Status |
|----------|----------------|--------|
| **Overselling** | Serial numbers validated inside transaction before creating Sale + SoldSerials. Unique index on `SoldSerial.serialNumber` prevents double insert. Product decrement does not currently enforce non-negative in create (allows oversell tracking); can be tightened with `enforceNonNegative` in service. | ✅ / ⚠️ |
| **Double return** | Each serial is marked returned via `findOneAndUpdate({ serialNumber, status: 'sold' }, { $set: { status: 'returned', ... } })`. Only one concurrent return can match per serial; second gets "already returned" error. | ✅ |
| **Optimistic locking** | Sale and SalesReturn use `optimisticConcurrency: true` (Mongoose `__v`). Conflicting updates throw; controller can retry or return 409. | ✅ |

---

## 5. Timestamps & Auditability

| Item | Implementation | Status |
|------|----------------|--------|
| **created_at / updated_at** | Mongoose `timestamps: true` on Sale, SalesReturn, LedgerEntry, SoldSerial, AuditLog, etc. Stored in UTC. | ✅ |
| **occurred_at** | Sale, SalesReturn, LedgerEntry have `occurredAt` for business event time. Backfill script: `src/scripts/backfill-occurred-at.js`. | ✅ |
| **UI date/time** | Frontend `dateUtils.ts`: Europe/London, 24h, DD/MM/YYYY HH:mm. Use `formatDateTimeLondon`, `formatDateLondon`, `formatOccurredAt`. | ✅ |
| **Audit log** | `AuditLog` model: entityType, entityId, action, changes (JSON), performedBy, performedAt (UTC), source (UI/API). Indexes on entityType+entityId, performedBy+performedAt, performedAt. Never delete. | ✅ |
| **Logging CREATE/UPDATE/DELETE/VOID/RETURN/REFUND** | Controllers call `auditService.logFromReq` after successful Sale create/update/delete, SalesReturn create/update/delete, Purchase create/update/delete, deletePurchaseItem. | ✅ |

---

## 6. Security

| Item | Implementation | Status |
|------|----------------|--------|
| **RBAC** | `authorize('admin', 'manager')` or `authorize('admin')` on sensitive routes (sales, returns, purchases, delete). | ✅ |
| **Manager approval for sensitive actions** | Structure in place; optional PIN or approval flow for voids/refunds/backdated edits can be added. | ⚠️ Documented |
| **Input validation** | Controllers validate type, required fields, min values. Express-validator available. | ✅ |
| **Security events** | Audit log captures performedBy, source; failed logins can be added to auth middleware. | ⚠️ Documented |

---

## 7. Migrations & Safe Rollout

| Item | Implementation | Status |
|------|----------------|--------|
| **Backwards compatibility** | New fields (`occurredAt`, validators) added with defaults or nullable; existing data remains valid. | ✅ |
| **Backfill** | `src/scripts/backfill-occurred-at.js` sets `occurredAt` from `createdAt`/`date` where null. | ✅ |
| **Indexes** | `src/scripts/ensure-indexes.js` runs `syncIndexes()` on Sale, SalesReturn, SoldSerial, AuditLog, LedgerEntry. | ✅ |
| **Rollback** | No destructive migrations; rollback = deploy previous code. New ledger behaviour (adjustment entries) is additive. | ✅ |

---

## 8. Tables / Modules Updated

| Module | Changes |
|--------|---------|
| **Sale** | Schema: min 0 for price/totals, optimisticConcurrency. Create via transaction. |
| **SalesReturn** | Schema: min 0 for amounts, unique sparse reference, optimisticConcurrency. Create via transaction; double-return safe. |
| **SoldSerial** | Unique index on serialNumber (existing). Return flow uses findOneAndUpdate. |
| **LedgerEntry** | No schema change. New adjustment entries for payment/sale edits; no deletes of payment_in. |
| **AuditLog** | Existing; used after all critical mutations. |
| **transactionService** | New: `runWithTransaction(callback)`, `supportsTransactions()`. |
| **salesTransactionService** | New: `createSaleInTransaction`, `createSalesReturnInTransaction`. |
| **salesController** | createSale uses transaction; updateSale uses adjustment entries only. |
| **salesReturnController** | createSalesReturn uses transaction. |
| **Frontend dateUtils** | Already present: London 24h formatting. |

---

## 9. Test Cases & Verification

- **tests/rigid-pos.test.js**: Sale create (transaction), double-return (one success, one failure), audit log created after sale.
- **scripts/verify-ledger-balance.js**: For a sample customer, recompute balance from LedgerEntries and compare to `Customer.balance`; report mismatches.

Run tests: `npm test`. Run verification: `node src/scripts/verify-ledger-balance.js` (optional, after seeding or in staging).
