/**
 * Dashboard helpers: permission checks, date range, and user location scope.
 * Date range: API accepts fromUtc, toUtc (ISO) from frontend (London time converted client-side).
 */

function can(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.permissionKeys && user.permissionKeys.has(key);
}

/**
 * User location scope for dashboard/reports. Admin sees all; others see assignedLocationIds merged with role locations.
 * @param {object} user - req.user (with role, assignedLocationIds, roles populated with assignedLocationIds)
 * @returns {null | string[]} null = all locations; [] or string[] = allowed location IDs (ObjectId strings)
 */
function getUserLocationScope(user) {
  if (!user) return null;
  if (user.role === 'admin') return null;
  
  // Collect location IDs from user's explicit assignments
  const userLocationIds = new Set();
  if (user.assignedLocationIds && Array.isArray(user.assignedLocationIds) && user.assignedLocationIds.length > 0) {
    user.assignedLocationIds.forEach((id) => {
      const idStr = id && id.toString ? id.toString() : String(id);
      if (idStr) userLocationIds.add(idStr);
    });
  }
  
  // Collect location IDs from user's roles
  const roleLocationIds = new Set();
  if (user.roles && Array.isArray(user.roles)) {
    user.roles.forEach((role) => {
      // Role can be ObjectId (not populated) or object (populated)
      const roleObj = role && typeof role === 'object' && role.assignedLocationIds ? role : null;
      if (roleObj && roleObj.assignedLocationIds && Array.isArray(roleObj.assignedLocationIds)) {
        roleObj.assignedLocationIds.forEach((id) => {
          const idStr = id && id.toString ? id.toString() : String(id);
          if (idStr) roleLocationIds.add(idStr);
        });
      }
    });
  }
  
  // Merge user and role locations
  const allLocationIds = new Set([...userLocationIds, ...roleLocationIds]);
  
  // If user has explicit locations, use those (user-level override)
  // Otherwise, if roles have locations, use role locations
  // Otherwise, return null (all locations)
  if (userLocationIds.size > 0) {
    // User has explicit assignments - use those (may be merged with role locations if both exist)
    return Array.from(allLocationIds);
  } else if (roleLocationIds.size > 0) {
    // User has no explicit assignments but roles have locations - use role locations
    return Array.from(roleLocationIds);
  } else {
    // Neither user nor roles have location assignments - access to all locations
    return null;
  }
}

/**
 * Sales KPIs: sale.view
 * Repairs: repair.view
 * Inventory/stock: product.view, stock.view
 * Parcels: purchase.view
 * Finance/accounts: accounts.view, report.view
 * Activity: audit.view
 */
function getDashboardPermissions(user) {
  return {
    sales: can(user, 'sale.view'),
    repairs: can(user, 'repair.view'),
    inventory: can(user, 'product.view') || can(user, 'stock.view'),
    parcels: can(user, 'purchase.view'),
    accounts: can(user, 'accounts.view'),
    reports: can(user, 'report.view'),
    audit: can(user, 'audit.view'),
  };
}

module.exports = { can, getDashboardPermissions, getUserLocationScope };
