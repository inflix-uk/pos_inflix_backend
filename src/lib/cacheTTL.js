/**
 * Centralised cache TTLs (seconds).
 *
 * Why these values: all list endpoints have ACTIVE invalidation on mutation
 * (the controllers call cache.bumpNs / bumpMany on every create/update/delete).
 * That means TTLs are only a fallback for the case when a foreign mutation
 * we didn't anticipate changed underlying data. So we can be generous —
 * longer TTLs = more cache hits = faster, smoother UX without staleness risk.
 *
 * Tune in one place; every controller reads from here.
 */

const SEC = 1;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

module.exports = {
    /**
     * Reference data — rarely changes, expensive to recompute, safe to cache long.
     * Settings, locations, pricing groups, taxes, platform catalogs, bank accounts.
     */
    REFERENCE: 30 * MIN,

    /**
     * Catalog data — changes occasionally; users do see updates because we invalidate
     * on every mutation. Products, customers, suppliers, categories, subcategories,
     * variant attributes, coupons, gift cards, platform tenants list.
     */
    CATALOG: 10 * MIN,

    /**
     * Transactional list data — changes frequently in normal POS usage but is
     * invalidated on every relevant mutation. Sales, returns, purchases,
     * repairs, stock adjustments/transfers, expenses, accounts.
     */
    TRANSACTIONAL: 5 * MIN,

    /**
     * Reports — heavy aggregations. Bumped on every business mutation that
     * could affect them; cheap to cache while you switch between reports.
     */
    REPORTS: 5 * MIN,

    /**
     * Activity log — append-only audit feed. Short window so it feels live
     * without invalidation hooks (we don't bump on every audit write).
     */
    ACTIVITY: 1 * MIN,

    /** Hot, low-cardinality keys (e.g. balance summaries) where freshness matters. */
    BALANCE: 2 * MIN,
};
