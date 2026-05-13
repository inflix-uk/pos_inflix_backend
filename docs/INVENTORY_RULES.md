# Rigid Inventory Rules

This document describes how in-stock and sold items are tracked and how the system enforces consistency.

## Sources of truth

1. **Purchases (parcels)** – `Purchase` model with `items[].imeis[]`: each IMEI/serial represents one unit in stock from that purchase.
2. **Sold serials** – `SoldSerial` model: each record means that serial number has been sold and is no longer in stock.
3. **Sales** – `Sale` model: full record of each transaction (retail or wholesale) with items and optional `serialNumbers` per line.
4. **Products** – `Product` model: SKU-based quantity used by POS; decremented when a sale is made.

## Rules enforced

### 1. A serial number can only be sold once

- Before creating a sale, the API checks that **no serial in the sale** already exists in `SoldSerial`.
- If any serial is already sold, the API returns `400` with message: `Serial number(s) already sold and cannot be sold again: <list>`.
- `SoldSerial.serialNumber` has a **unique index** so the database also prevents duplicate sold serials.

### 2. Every sold serial is recorded

- When a sale is created, for every `item.serialNumbers[]` entry, a `SoldSerial` document is created with:
  - `serialNumber`
  - `saleId` (reference to the sale)
  - `soldAt`
- This is the permanent record that the unit is sold and must be excluded from in-stock views.

### 3. In-stock (serial/IMEI) view

- **In stock** = serials that appear in purchase items’ `imeis[]` and do **not** appear in `SoldSerial`.
- `GET /api/purchases?excludeSold=true` returns purchases with each item’s `imeis` filtered to **only those not in SoldSerial**. Items that end up with no IMEIs are omitted from the item list.
- The Products / Stock view uses this to show only available units; the Sold tab uses `GET /api/sales/sold-serials` to show which serials were sold and to whom.

### 4. Product quantity (SKU) is decremented on sale

- When a sale is created, `Product` documents matching item SKUs are updated: `quantity` is reduced by the sold quantity (never below zero).
- This keeps POS product list and quantity in sync with sales.

## Summary

| Concept        | Where it’s stored              | Rule / use |
|----------------|---------------------------------|------------|
| In-stock serials | Purchase items’ `imeis[]` minus SoldSerial | Shown when `excludeSold=true` |
| Sold serials   | `SoldSerial` + `Sale`           | One record per sold serial; unique; used for “Sold” view and to exclude from stock |
| Sales          | `Sale`                          | Full transaction; items may include `serialNumbers` |
| Product qty    | `Product.quantity`              | Decremented on sale; never negative |

These rules keep a rigid separation between **in stock** and **sold** and prevent the same serial from being sold twice.
