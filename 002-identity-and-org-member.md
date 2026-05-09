# Identity Schema — LLM Reference

> **Collection**: `identities`
> **Model name**: `Identity`
> **Role**: Authentication record. A human who can log in. Previously called "User".

---

## What is an Identity?

An Identity is a login account — email, password, 2FA. It has NO business permissions, NO fund access, and NO accounting capabilities until connected to an Organization via `OrganizationMember`.

**Why "Identity" and not "User"?** "User" collides with auth middleware and JWT libraries. "Account" collides with GL accounts in the chart of accounts. "Identity" is clean and unambiguous.

## Fields That Matter for Accounting

| Field | Why |
|-------|-----|
| `_id` | Referenced as `performedBy` in every audit log. Referenced as `createdBy`, `postedBy` on Journals. Answers: "who posted this entry?" |
| `timezone` | Resolves date ambiguity. A person in IST creating a journal at 2am IST (still "yesterday" in EST) — the system uses this to confirm intent. |
| `platformRole` | `PLATFORM_ADMIN` can access any org's data for support. This is a VCFO staff role, not a business role. |

## Fields That DO NOT Affect Accounting

Everything else — email, name, avatar, 2FA, login timestamps — is auth/identity only.

## Relationships

| Related Collection | Relationship | Join Key |
|-------------------|--------------|----------|
| `OrganizationMember` | Identity has many memberships | `OrganizationMember.identityId` → `Identity._id` |
| `Journal` | Identity creates/posts journals | `Journal.createdBy` / `Journal.postedBy` → `Identity._id` |
| `AuditLog` | Identity performs auditable actions | `AuditLog.performedBy` → `Identity._id` |

## Migration from Old Schema

| Old Field (User) | New Field (Identity) | Notes |
|-------------------|---------------------|-------|
| `User._id` | `Identity._id` | **Preserve IDs** — every audit log, journal, and ref points here |
| `firstName` | `firstName` | Direct |
| `lastName` | `lastName` | Direct |
| `email` | `email` | Direct |
| `password` | `passwordHash` | Rename for clarity. Same bcrypt hash. |
| `cognitoSub` | `cognitoSub` | Direct |
| `isZiveSuperAdmin=true` | `platformRole = "PLATFORM_ADMIN"` | Boolean → enum |
| `isZiveCompliance=true` | `platformRole = "COMPLIANCE"` | Boolean → enum |
| `isZiveServicesAdmin=true` | `platformRole = "PLATFORM_SUPPORT"` | Boolean → enum |
| `is2FaEnabled` | `twoFactor.isEnabled` | Nested |
| `is2FaCompleted` | `twoFactor.isVerified` | Nested |
| `secret2faKey` | `twoFactor.secret` | Nested |
| `status` | `status` | Map: "DEACTIVE" → "DEACTIVATED" |
| `lastLogin` / `lastLoginDate` | `lastLoginAt` | Unified |
| `logo` | `avatarUrl` | Rename |
| `kyc` / `aml` | — | Moves to InvestorKyc (future) |
| `personalDetails` | — | Moves to InvestorKyc (future) |
| `isNewUser` / `isDemoUser` / `showFund` | — | Dropped. UI state. |
| `tokenId` | — | Dropped. Session management. |

---

# OrganizationMember Schema — LLM Reference

> **Collection**: `organizationmembers`
> **Model name**: `OrganizationMember`
> **Role**: Links an Identity to an Organization with a specific role.

---

## What is an OrganizationMember?

It answers: "Does this person have access to this organization, and what can they do?" One Identity can be a member of multiple Organizations (e.g., an accountant who serves multiple GP firms).

## Permission Matrix

| Role | Post Journal | Approve Journal | Manage CoA | Manage Members | Manage Funds | View Reports |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| OWNER | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ADMIN | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| PARTNER | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| ACCOUNTANT | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| ANALYST | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| VIEWER | ❌ | ❌ | ❌ | ❌ | ❌ | Dashboard only |

## For LLM Operations

When determining if an identity can perform an action:

```
1. Find OrganizationMember where { organizationId, identityId, status: "ACTIVE" }
2. Check member.role against the permission matrix above
3. For fund-specific actions, ALSO check FundRole (future schema)
```

**Segregation of duties**: ACCOUNTANT can create and post journals but CANNOT approve.
The person who creates an entry should not be the same person who approves it.

## Relationships

| Related Collection | Relationship | Join Key |
|-------------------|--------------|----------|
| `Organization` | Member belongs to one org | `organizationId` → `Organization._id` |
| `Identity` | Member IS one identity | `identityId` → `Identity._id` |
| `FundRole` | Member may have fund-specific roles | `FundRole.organizationMemberId` → `OrganizationMember._id` |

## Migration from Old Schema

**What comes HERE (OrganizationMember):**

| Old Field (Role) | New Field (OrganizationMember) | Notes |
|-------------------|-------------------------------|-------|
| `Role.userId` | `identityId` | Maps through old User._id (preserved as Identity._id) |
| `Role.entityId` | `organizationId` | Maps through Entity → Organization lookup |
| `Role.accessType` | `role` | Map: "ADMIN" → "ADMIN", "USER" → "VIEWER", etc. |
| `Role.status` | `status` | Map: "NOT INVITED" → "INVITED", etc. |
| `Role.createdAt` | `invitedAt` | Approximation |
| `Role.lastLoginDate` | `lastActiveAt` | Direct |

**What goes ELSEWHERE:**

| Old Field Category (Role) | New Home | Why |
|---------------------------|----------|-----|
| LP onboarding fields | `InvestorOnboarding` | Not an org membership concern |
| W8/W9 forms | `InvestorTaxForms` | Tax data ≠ role assignment |
| Banking details | `InvestorBanking` | Financial data ≠ role assignment |
| Accreditation booleans | `InvestorAccreditation` | Compliance ≠ role assignment |
| KYC/identity fields | `InvestorKyc` | Verification ≠ role assignment |
| Fund-specific role | `FundRole` | Per-fund access ≠ org access |
| Partner capital data | `Investor` | LP financial position ≠ role assignment |
