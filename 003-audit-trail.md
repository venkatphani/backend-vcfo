# AuditTrail Schema & Middleware — LLM Reference

> **Collection**: `audittrails`
> **Model name**: `AuditTrail`
> **Role**: Immutable append-only log of every data change across all collections.

---

## What is AuditTrail?

Every CREATE, UPDATE, DELETE, and status transition in VCFO automatically writes a record here. It's the single source of truth for "who did what, when, and what changed." Auditors, compliance teams, and security investigations all start here.

## Immutability Rules

1. **Insert only** — documents are NEVER updated. Pre-hooks block `updateOne`, `updateMany`, `findOneAndUpdate`.
2. **No deletes** — pre-hooks block `deleteOne`, `deleteMany`, `findOneAndDelete`.
3. **No TTL on financial entries** — fund accounting audits require 7-10 year retention.
4. **Self-contained** — each entry includes denormalized actor info (name, email, role at time of action) so you never need to join to understand an entry.

## Schema Fields

| Field | Type | Purpose |
|-------|------|---------|
| `organizationId` | ObjectId → Organization | Which tenant |
| `fundId` | ObjectId → Fund | Which fund (null for org-level events) |
| `performedBy` | ObjectId → Identity | Who did it |
| `actorSnapshot` | { email, fullName, role } | Denormalized actor info at time of action |
| `action` | Enum | WHAT happened (see actions list below) |
| `category` | Enum | Broad grouping for filtering |
| `targetModel` | String | Which collection was affected ("Journal", "Organization", etc.) |
| `targetId` | ObjectId | The specific document that changed |
| `targetLabel` | String | Human-readable label ("JE-2026-001", "Fund I") |
| `changes` | Mixed | The diff — see format below |
| `reason` | String | Why the change was made (free text) |
| `source` | Enum | How it was triggered (UI, API, SYSTEM, MIGRATION, IMPORT, INTEGRATION) |
| `ipAddress` | String | Request IP |
| `correlationId` | String | Groups multiple audit entries from a single API request |
| `occurredAt` | Date | Immutable timestamp |

## Actions Enum

| Action | When Used |
|--------|-----------|
| `CREATE` | New document inserted |
| `UPDATE` | Existing document modified |
| `DELETE` / `SOFT_DELETE` | Document removed |
| `STATUS_CHANGE` | Any status field transition |
| `APPROVE` / `REJECT` / `SUBMIT` | Workflow transitions |
| `JOURNAL_POST` | Journal moved to POSTED status (hits the GL) |
| `JOURNAL_REVERSE` | Reversing entry created |
| `PERIOD_OPEN` / `PERIOD_CLOSE` | Accounting period lifecycle |
| `FX_RATE_SET` | Exchange rate created or changed |
| `VALUATION_MARK` | Investment fair value updated |
| `LOGIN` / `LOGIN_FAILED` / `LOGOUT` | Auth events |
| `ROLE_CHANGE` / `PERMISSION_CHANGE` | Access control changes |
| `IMPORT` / `EXPORT` / `MIGRATE` / `BULK_UPDATE` | Data operations |

## Categories Enum

| Category | Covers |
|----------|--------|
| `AUTH` | Login, logout, 2FA events |
| `ACCESS_CONTROL` | Role changes, invitations, permissions |
| `ORGANIZATION` | Org settings, billing, features |
| `FUND` | Fund config, fund lifecycle |
| `ACCOUNTING` | Journals, CoA, periods, FX, valuations |
| `INVESTOR` | LP data, commitments, onboarding |
| `INVESTMENT` | Portfolio companies, transactions |
| `CAPITAL_ACTIVITY` | Capital calls, distributions |
| `BANKING` | Bank details, bank feeds |
| `DOCUMENT` | Document uploads, signatures |
| `SYSTEM` | Migrations, bulk ops, integrations |

## Changes Field Format

**For CREATE:**
```json
{
  "name": { "after": "Fund III" },
  "baseCurrency": { "after": "USD" },
  "status": { "after": "ACTIVE" }
}
```

**For UPDATE (diff only — unchanged fields are omitted):**
```json
{
  "status": { "before": "DRAFT", "after": "POSTED" },
  "totalDebitFunctional": { "before": "0", "after": "1000000.00" }
}
```

**For DELETE (full snapshot):**
```json
{
  "name": { "after": "Old Fund" },
  "status": { "after": "ACTIVE" }
}
```

**Redacted fields:**
```json
{
  "passwordHash": { "before": "[REDACTED]", "after": "[REDACTED]" }
}
```

## How the Middleware Works

Every schema attaches the audit middleware with configuration:

```javascript
const auditMiddleware = require("../middleware/auditMiddleware");

auditMiddleware(journalSchema, {
  modelName: "Journal",          // → targetModel
  category: "ACCOUNTING",       // → category
  getLabel: (doc) => doc.journalNumber,  // → targetLabel
  redactFields: [],              // additional fields to redact
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});
```

**Context is passed per-operation** (not globally):

```javascript
// Document save
doc.$locals.auditContext = {
  performedBy: req.identity._id,
  organizationId: req.params.orgId,
  actorSnapshot: { email: req.identity.email, fullName: "Alice Smith", role: "ACCOUNTANT" },
  reason: "Correcting FX rate on Q1 closing entry",
  source: "UI",
  correlationId: req.correlationId,
  ipAddress: req.ip,
};
await doc.save();

// Query update
await Model.findOneAndUpdate(filter, update, {
  new: true,
  auditContext: { performedBy, organizationId, ... }
});
```

## For LLM Operations

To trace the complete history of any document:
```
AuditTrail.find({
  targetModel: "Journal",
  targetId: journalId
}).sort({ occurredAt: 1 })
```

To find all actions by a specific person in a fund:
```
AuditTrail.find({
  performedBy: identityId,
  fundId: fundId
}).sort({ occurredAt: -1 })
```

To find all changes in a single API request:
```
AuditTrail.find({ correlationId: "req-abc-123" })
```

## Indexes (6 total)

| Index | Query Pattern |
|-------|--------------|
| `{ organizationId: 1, occurredAt: -1 }` | Org audit dashboard |
| `{ fundId: 1, category: 1, occurredAt: -1 }` | Fund audit by category |
| `{ performedBy: 1, occurredAt: -1 }` | "What did this person do?" |
| `{ targetModel: 1, targetId: 1, occurredAt: -1 }` | Document history |
| `{ organizationId: 1, action: 1, occurredAt: -1 }` | Action-filtered search |
| `{ correlationId: 1 }` (sparse) | Multi-doc request tracing |

## Migration from Old Schema

| Old (AuditLog) | New (AuditTrail) | Notes |
|----------------|------------------|-------|
| `action` (free string) | `action` (enum) | Map old strings to AUDIT_ACTIONS |
| `model` | `targetModel` | Direct |
| `recordId` | `targetId` | Direct |
| `oldData` | `changes` (before values) | Restructure into diff format |
| `newData` | `changes` (after values) | Restructure into diff format |
| `performedBy` | `performedBy` | Direct (maps to Identity._id) |
| `fundId` | `fundId` | Direct |
| `updatedFields` | — | Absorbed into `changes` diff |
| `timestamp` | `occurredAt` | Direct |
| — (missing) | `organizationId` | Derive from fundId → Fund → Organization |
| — (missing) | `category` | Derive from `model` field |
| — (missing) | `actorSnapshot` | Backfill from Identity records |
| — (missing) | `source` | Default to "UI" for historical |
| — (missing) | `correlationId` | Not available for old data |
