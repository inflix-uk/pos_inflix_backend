# How to Create Users and Assign Them to Specific Locations

This guide shows you how to create additional users and assign them to specific locations for testing the multi-tenant + multi-location implementation.

---

## Method 1: Using the Script (Easiest) 🚀

### Step 1: List Available Locations

First, check what locations exist:

```bash
cd d:\Pos\pos_inflix_backend
node scripts/list-locations.js
```

### Step 2: Create a User with Location Assignments

```bash
node scripts/create-user-with-locations.js "Manager Name" "manager@test.com" "Password123!" "manager" "Location1,Location2" "Location1"
```

**Parameters:**
- `"Manager Name"` - User's full name
- `"manager@test.com"` - User's email
- `"Password123!"` - User's password (min 8 chars)
- `"manager"` - User's role (admin, manager, cashier, staff, warehouse)
- `"Location1,Location2"` - Comma-separated list of location names to assign
- `"Location1"` - Default location (optional, uses first assigned if not specified)

**Example:**
```bash
# Create a manager with access to two locations
node scripts/create-user-with-locations.js "John Manager" "john@test.com" "Manager123!" "manager" "Store A,Store B" "Store A"

# Create a cashier with access to one location
node scripts/create-user-with-locations.js "Jane Cashier" "jane@test.com" "Cashier123!" "cashier" "Store A" "Store A"

# Create a user with no location restrictions (access to all)
node scripts/create-user-with-locations.js "Admin User" "admin2@test.com" "Admin123!" "admin"
```

---

## Method 2: Using the API Directly 🌐

### Step 1: Get Your Auth Token

Login first to get your JWT token:

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@test.com",
    "password": "Admin123!"
  }'
```

Copy the `token` from the response.

### Step 2: List Locations

Get all locations to find their IDs:

```bash
curl -X GET http://localhost:5000/api/locations \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Step 3: Create a User with Locations

```bash
curl -X POST http://localhost:5000/api/admin/users \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Manager Name",
    "email": "manager@test.com",
    "password": "Password123!",
    "roleIds": [],
    "isActive": true,
    "assignedLocationIds": ["LOCATION_ID_1", "LOCATION_ID_2"],
    "defaultLocationId": "LOCATION_ID_1"
  }'
```

**Replace:**
- `YOUR_TOKEN_HERE` with your JWT token
- `LOCATION_ID_1`, `LOCATION_ID_2` with actual location IDs from Step 2

**Example:**
```json
{
  "name": "John Manager",
  "email": "john@test.com",
  "password": "Manager123!",
  "roleIds": [],
  "isActive": true,
  "assignedLocationIds": ["69bc2d0700dc28d6d912dd7a", "69bc2d0700dc28d6d912dd7b"],
  "defaultLocationId": "69bc2d0700dc28d6d912dd7a"
}
```

---

## Method 3: Using the Frontend UI (If Available) 🖥️

1. **Login** as admin at `http://localhost:3000/login`
2. **Navigate** to Settings → Admin → Users
3. **Click** "Create User" or "Add User"
4. **Fill in** the form:
   - Name
   - Email
   - Password
   - Role
   - **Assigned Locations** (select one or more)
   - **Default Location** (must be one of assigned locations)
5. **Save** the user

**Note:** If the frontend UI doesn't have location assignment fields yet, use Method 1 or 2.

---

## Method 4: Update Existing User's Locations 🔄

### Using Script (Update)

You can update an existing user's location assignments:

```bash
# First, get the user ID and location IDs
# Then use the API to update
```

### Using API

```bash
curl -X PUT http://localhost:5000/api/admin/users/USER_ID \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "assignedLocationIds": ["LOCATION_ID_1", "LOCATION_ID_2"],
    "defaultLocationId": "LOCATION_ID_1"
  }'
```

---

## Understanding Location Assignments 📍

### Admin Users
- **assignedLocationIds:** Empty or null
- **Access:** All locations in the tenant
- **Behavior:** Can see and manage data from all locations

### Non-Admin Users
- **assignedLocationIds:** Array of location IDs
- **Access:** Only assigned locations
- **Behavior:** 
  - Can only see sales, repairs, stock from assigned locations
  - Cannot create records for locations outside their scope
  - Get 404 when trying to access records from other locations

### Default Location
- **defaultLocationId:** One of the assigned location IDs
- **Purpose:** Used as default when creating new sales/repairs
- **Requirement:** Must be one of `assignedLocationIds` (if assignedLocationIds is non-empty)

---

## Testing Location-Based Access Control 🧪

After creating users with location assignments:

1. **Login as the new user**
2. **Create a sale/repair** - Should default to their defaultLocationId
3. **Try to access data from another location** - Should get 404 or filtered results
4. **Verify dashboard** - Should only show data from assigned locations
5. **Verify reports** - Should only show data from assigned locations

---

## Quick Examples 💡

### Example 1: Store Manager (Multiple Locations)
```bash
node scripts/create-user-with-locations.js "Store Manager" "manager@test.com" "Manager123!" "manager" "Store A,Store B,Store C" "Store A"
```

### Example 2: Single Store Cashier
```bash
node scripts/create-user-with-locations.js "Cashier" "cashier@test.com" "Cashier123!" "cashier" "Store A" "Store A"
```

### Example 3: Warehouse Staff
```bash
node scripts/create-user-with-locations.js "Warehouse Staff" "warehouse@test.com" "Warehouse123!" "warehouse" "Warehouse 1" "Warehouse 1"
```

### Example 4: Admin (All Locations)
```bash
node scripts/create-user-with-locations.js "Admin 2" "admin2@test.com" "Admin123!" "admin"
# No location assignment = access to all
```

---

## Troubleshooting 🔧

### Error: "Location not found"
- Make sure locations exist first: `node scripts/list-locations.js`
- Check location names match exactly (case-insensitive)

### Error: "defaultLocationId must be one of assignedLocationIds"
- The default location must be in the assigned locations list
- Fix: Include the default location in the comma-separated list

### Error: "Email already in use"
- User with that email already exists
- Use a different email or update the existing user

### Error: "You do not have permission"
- Make sure you're logged in as admin
- Check your JWT token is valid

---

## Next Steps 🎯

1. **Create locations** (if you haven't already)
2. **Create users** with different location assignments
3. **Test access control** - Login as different users and verify they only see their assigned locations
4. **Create test data** - Sales, repairs, stock transfers
5. **Verify isolation** - Ensure users can't access data from other locations

---

## API Reference 📚

### Create User Endpoint
- **URL:** `POST /api/admin/users`
- **Auth:** Required (Bearer token with `user.manage` permission)
- **Body:**
  ```json
  {
    "name": "string (required)",
    "email": "string (required, unique)",
    "password": "string (required, min 8 chars)",
    "roleIds": ["array of role ObjectIds"],
    "isActive": true,
    "phone": "string (optional)",
    "assignedLocationIds": ["array of location ObjectIds"],
    "defaultLocationId": "location ObjectId (optional)"
  }
  ```

### Update User Endpoint
- **URL:** `PUT /api/admin/users/:id`
- **Auth:** Required (Bearer token with `user.manage` permission)
- **Body:** Same as create, all fields optional
