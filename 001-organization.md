# Organization Schema — LLM Reference

> **Collection**: `organizations`
> **Model name**: `Organization`
> **Role**: Root tenant. Every other collection in VCFO references an Organization directly or transitively.

---

## What is an Organization?

An Organization is a **GP firm, fund administrator, family office, or angel group** — the real-world entity that manages one or more investment funds. Think of it as the top of the tree:

```
Organization (e.g., "Sequoia Capital")
├── Fund I (closed-end VC fund)
├── Fund II (closed-end VC fund)
├── SPV-Acme (co-invest SPV)
└── Members
    ├── Alice (ADMIN)
    ├── Bob (ACCOUNTANT)
    └── Carol (VIEWER)
```

## Fields That Matter for Accounting

| Field | Type | Why It Matters |
|-------|------|----------------|
| `baseCurrency` | String (ISO 4217, e.g., "USD") | **Reporting currency for consolidation.** When you roll up multiple funds with different functional currencies into one set of financials, you translate into this currency. ASC 830 rules apply. |
| `fiscalYearEndMonth` | Number (1–12) | Determines period boundaries. A Dec-31 year-end means Q1 = Jan–Mar. A Mar-31 year-end means Q1 = Apr–Jun. All period-locking, closing entries, and financial statement dates derive from this. |
| `fiscalYearEndDay` | Number (1–31) | Usually 31, but some orgs use non-month-end fiscal years. |
| `defaultAccountingStandard` | Enum | Drives chart of accounts templates, financial statement layouts, and valuation treatment. `US_GAAP_ASC946` = Investment Company accounting (fair value, no depreciation of investments). |
| `timezone` | String (IANA) | Resolves "today" for journal posting. A journal posted at 11pm ET on Dec 31 is in the current fiscal year; posted at 1am Tokyo time Jan 1 might be next year. |

## Fields That DO NOT Affect Accounting

| Field | Purpose |
|-------|---------|
| `slug` | URL routing only |
| `logo`, `backgroundImage` | UI branding |
| `billing.*` | Subscription management |
| `features.*` | Feature toggles |
| `metadata` | Extensibility bucket |

## Relationships

| Related Collection | Relationship | Join Key |
|-------------------|--------------|----------|
| `Fund` | Organization has many Funds | `Fund.organizationId` → `Organization._id` |
| `OrganizationMember` | Organization has many Members | `OrganizationMember.organizationId` → `Organization._id` |
| `Identity` | Indirect via OrganizationMember | `OrganizationMember.identityId` → `User._id` |

## Key Constraints

1. **`slug` is globally unique** — no two organizations share a slug.
2. **`baseCurrency` is immutable in practice** — changing it would require re-translating all historical consolidated reports. The schema doesn't enforce immutability, but the application layer should block changes after the first Fund is created.
3. **`createdBy` is immutable** — set once at creation, never changed. Current admins are tracked in `OrganizationMember`.
4. **`status = SUSPENDED`** means the org exists but cannot create new journals or funds. Existing data remains readable.

## For LLM Math Operations

When computing across an Organization's funds:

1. **Each Fund has its own functional currency** (set on the Fund, not here).
2. **To consolidate**: translate each Fund's trial balance from its functional currency to `Organization.baseCurrency` using the FxRate collection.
3. **Balance sheet items** (assets, liabilities, equity): use **period-end spot rate**.
4. **Income/expense items**: use **period average rate**.
5. **Partner capital**: use **historical rates** (the rate on the date each contribution/distribution occurred).
6. **CTA (Cumulative Translation Adjustment)**: the balancing plug goes to equity as a separate line item.

## Migration from Old Schema

| Old Field (Entity) | New Field (Organization) | Notes |
|--------------------|--------------------------|-------|
| `Entity.name` | `Organization.name` | Direct |
| `Entity.email` | `Organization.email` | Direct |
| `Entity.website` | `Organization.website` | Direct |
| `Entity.logo` | `Organization.logo` | Direct |
| `Entity.backgroundImage` | `Organization.backgroundImage` | Direct |
| `Entity.yearFounded` | `Organization.yearFounded` | Cast String → Number |
| `Entity.entityDomicile` | `Organization.domicile` | Normalize to ISO 3166-1 alpha-2 |
| `Entity.country` | `Organization.legalAddress.country` | Normalize to ISO code |
| `Entity.address` | `Organization.legalAddress.line1` | Split if structured |
| `Entity.state` | `Organization.legalAddress.state` | Direct |
| `Entity.zipCode` | `Organization.legalAddress.zipCode` | Direct |
| `Entity.stripeCustomerId` | `Organization.billing.stripeCustomerId` | Nested |
| `Entity.lastPaidDate` | `Organization.billing.lastPaidDate` | Nested |
| `Entity.expiryDate` | `Organization.billing.expiryDate` | Nested |
| `Entity.status` | `Organization.status` | Map: "APPROVED" → "ACTIVE", "PENDING" → "ACTIVE" |
| `Entity.createdBy` | `Organization.createdBy` | Direct |
| `Entity.type` | — | **Not migrated here.** Entity.type mixed org types with fund types. Only org-level types ("GP", "MANAGEMENT COMPANY", "FUND ANALYTICS") map here. Fund-level types ("FUND", "SPV") move to Fund.type |
| `Entity.showJournals`, `Entity.showCrypto`, etc. | `Organization.features.*` | Map 30+ booleans into features object |
| `Entity.fundFamily` | — | Moves to Fund or dropped |
| `Entity.restrictedCash`, `Entity.incomingWires` | — | Moves to Fund accounting |
| `Entity.bankName`, `Entity.routingNumber`, etc. | — | Moves to dedicated BankAccount collection |
| `Entity.config.*` | `Organization.features.*` or `Organization.metadata` | Case by case |

### Entities That Become Funds (not Organizations)

Any `Entity` document where `type` is one of: `"FUND"`, `"SPV"`, `"FUND OF FUND"`, `"FUND RAISE"`, `"SIMULATION"`, `"DASHBOARD"`, `"LP DASHBOARD"`, `"BLUE CHECK"`, `"ANGEL"`, `"CRM"`, `"HOLDING CO"`, `"VCFO"` — these become `Fund` documents under an Organization, not Organizations themselves.

The migration script must:
1. Group Entity records by `createdBy` (or by `group` if set) to determine which Entities belong to the same Organization.
2. Create one Organization per group.
3. Create Fund records for each Entity, linked to the appropriate Organization.
