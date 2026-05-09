# Migration Script: Entity → Organization

## Strategy

The old `Entity` collection is a god-object that mixes organization-level data with
fund-level data. This migration **splits** each Entity into:

1. An **Organization** (this migration)
2. A **Fund** (separate migration, 004-fund.md)

## Step-by-step

### Step 1: Identify Organization Groups

Old Entities have no explicit "organization" parent. We infer grouping:

```javascript
// Option A: Group by `Entity.group` field (if populated)
// Option B: Group by `Entity.createdBy` user
// Option C: Treat each Entity as its own org (simplest, refine later)

// Recommended: Option C for v1 migration, then merge orgs manually
```

### Step 2: Create Organization Documents

```javascript
const migrateEntityToOrganization = async (entity) => {
  // Only create an Organization for the FIRST entity in a group.
  // Subsequent entities in the same group become Funds.

  const org = {
    name: entity.name,
    slug: generateSlug(entity.name, entity._id), // ensure uniqueness
    type: mapEntityTypeToOrgType(entity.type),

    logo: entity.logo,
    backgroundImage: entity.backgroundImage,

    email: entity.email,
    website: entity.website,

    legalAddress: {
      line1: entity.address || null,
      state: entity.state || null,
      zipCode: entity.zipCode || null,
      country: normalizeCountry(entity.country), // "United States" → "US"
    },

    domicile: normalizeCountry(entity.entityDomicile),
    taxId: null, // not in old schema — must be populated manually

    yearFounded: entity.yearFounded ? parseInt(entity.yearFounded, 10) : null,

    baseCurrency: "USD", // old schema had no currency — default to USD
    fiscalYearEndMonth: 12,
    fiscalYearEndDay: 31,
    defaultAccountingStandard: "US_GAAP_ASC946",
    timezone: "America/New_York",

    status: entity.status === "APPROVED" ? "ACTIVE" : "ACTIVE",

    createdBy: entity.createdBy,

    billing: {
      stripeCustomerId: entity.stripeCustomerId || null,
      lastPaidDate: entity.lastPaidDate || null,
      expiryDate: entity.expiryDate || null,
      plan: "FREE", // determine from old billing data
    },

    features: {
      multiCurrency: false,
      bankFeedSync: !entity.disableCashFlow,
      aiJournalEntry: entity.aiOnboarding || false,
      lpPortalAccess: true,
      cryptoTracking: entity.showCrypto || false,
      customReports: entity.extensiveFundReport || false,
      auditWorkflow: false,
    },

    metadata: {
      _migratedFrom: "Entity",
      _oldEntityId: entity._id,
      _migratedAt: new Date(),
    },
  };

  return org;
};
```

### Step 3: Type Mapping

```javascript
const mapEntityTypeToOrgType = (entityType) => {
  const mapping = {
    "GP":                   "GP",
    "MANAGEMENT COMPANY":   "GP",
    "FUND ANALYTICS":       "GP",
    "ANGEL":                "ANGEL_GROUP",
    "CRM":                  "GP",
    "HOLDING CO":           "HOLDING_COMPANY",
    // Everything else (FUND, SPV, etc.) → default to GP
    // because those entity types represent funds, not orgs
  };
  return mapping[entityType] || "GP";
};
```

### Step 4: Country Normalization

```javascript
const normalizeCountry = (country) => {
  if (!country) return null;
  const map = {
    "United States": "US",
    "United Kingdom": "GB",
    "India": "IN",
    "Cayman Islands": "KY",
    "Luxembourg": "LU",
    "Singapore": "SG",
    // ... extend as needed from COUNTRIES enum
  };
  return map[country] || country.substring(0, 2).toUpperCase();
};
```

### Step 5: Post-Migration Validation

```javascript
// For each migrated Organization:
// 1. Verify slug uniqueness
// 2. Verify createdBy references a valid Identity
// 3. Log any entities that couldn't be mapped
// 4. Create a lookup table: oldEntityId → newOrganizationId
//    (needed for Fund migration and all downstream schemas)
```

### Step 6: Build Lookup Table

```javascript
// Critical: store this mapping for ALL subsequent migrations
// Every other migration (Fund, Role, Journal, etc.) needs to know
// which Organization an old Entity maps to.

const migrationLookup = {
  entityToOrg: new Map(),  // oldEntityId → newOrgId
};
```

## Rollback

```javascript
// Delete all Organizations where metadata._migratedFrom === "Entity"
await Organization.deleteMany({ "metadata._migratedFrom": "Entity" });
```

## Estimated Impact

| Metric | Estimate |
|--------|----------|
| Entity records (approx) | Varies per deployment |
| Organizations created | ~1 per user/group |
| Fields migrated | 15 of ~200 (rest go to Fund) |
| Fields dropped | ~30 (UI flags, error objects, deprecated booleans) |
| Manual follow-up | taxId, timezone, domicile normalization |
