/**
 * ============================================================================
 * VCFO SCHEMA: AuditTrail
 * ============================================================================
 *
 * WHAT THIS IS:
 *   Immutable, append-only log of every data change in VCFO. Every create,
 *   update, delete, and status transition across ALL collections is recorded
 *   here. This is the single source of truth for "who did what, when, and
 *   what changed."
 *
 * WHY "AUDIT TRAIL" AND NOT "AUDIT LOG":
 *   - Avoids collision with the old "AuditLog" collection name during migration.
 *   - "Trail" implies a sequence you can follow — which is exactly what
 *     auditors and compliance teams need.
 *
 * DESIGN PRINCIPLES:
 *   1. IMMUTABLE — documents are NEVER updated or deleted. Insert-only.
 *   2. SELF-CONTAINED — each entry contains enough context to understand
 *      the change without querying other collections (denormalized actor
 *      name, org name, etc.).
 *   3. SCOPED — every entry is scoped to an Organization (and optionally
 *      a Fund) so queries are efficient and tenant-isolated.
 *   4. DIFF-BASED — stores only the fields that changed (before/after),
 *      not the entire document snapshot. Saves storage, makes diffs readable.
 *   5. STRUCTURED — `action` and `category` are enums, not free strings.
 *      This makes filtering, dashboards, and compliance reports reliable.
 *
 * ACCOUNTING RELEVANCE:
 *   Critical. Auditors need to trace:
 *   - Who posted a journal, when, and what approval chain it went through
 *   - When a GL account was added/modified/deactivated
 *   - When a period was opened/closed and by whom
 *   - Who changed FX rates and when
 *   - Who modified LP commitment amounts
 *   - Every change to banking details (for fraud detection)
 *
 * RETENTION:
 *   Fund accounting audits typically require 7-10 years of history.
 *   Consider TTL indexes only for non-financial audit entries (e.g., login
 *   events) after consultation with compliance. Financial audit entries
 *   must NEVER expire.
 *
 * INDEXES:
 *   See bottom of file — optimized for the 5 most common audit queries.
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Every audit entry must have one of these actions.
 * No free-form strings — this makes compliance reporting filterable.
 */
const AUDIT_ACTIONS = [
  // CRUD
  "CREATE",
  "UPDATE",
  "DELETE",
  "SOFT_DELETE",

  // Lifecycle transitions
  "STATUS_CHANGE",       // any status field change (DRAFT→POSTED, ACTIVE→SUSPENDED, etc.)
  "APPROVE",
  "REJECT",
  "SUBMIT",
  "REVERSE",

  // Auth & access
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "INVITE",
  "ACCEPT_INVITE",
  "ROLE_CHANGE",
  "PERMISSION_CHANGE",

  // Accounting-specific
  "JOURNAL_POST",        // distinct from CREATE — this is when it hits the GL
  "JOURNAL_REVERSE",
  "PERIOD_OPEN",
  "PERIOD_CLOSE",
  "FX_RATE_SET",
  "VALUATION_MARK",

  // Data operations
  "IMPORT",
  "EXPORT",
  "MIGRATE",
  "BULK_UPDATE",
];

/**
 * Category groups related actions for filtering and dashboards.
 * An auditor can say "show me all ACCOUNTING events" without knowing
 * every specific action type.
 */
const AUDIT_CATEGORIES = [
  "AUTH",                // login, logout, 2FA
  "ACCESS_CONTROL",     // role changes, invitations, permissions
  "ORGANIZATION",       // org settings, billing, features
  "FUND",               // fund config, fund lifecycle
  "ACCOUNTING",         // journals, CoA, periods, FX, valuations
  "INVESTOR",           // LP data, commitments, onboarding
  "INVESTMENT",         // portfolio companies, transactions
  "CAPITAL_ACTIVITY",   // capital calls, distributions
  "BANKING",            // bank details, bank feeds
  "DOCUMENT",           // document uploads, signatures
  "SYSTEM",             // migrations, bulk ops, integrations
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const auditTrailSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope — WHERE did this happen?
    // ------------------------------------------------------------------

    /**
     * Which organization this event belongs to.
     * Required for ALL events except platform-level actions (login by
     * platform admin before selecting an org).
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },

    /**
     * Which fund this event relates to (if fund-scoped).
     * Null for org-level events (e.g., adding a member, changing org settings).
     */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      index: true,
    },

    // ------------------------------------------------------------------
    // Actor — WHO did this?
    // ------------------------------------------------------------------

    /** The Identity who performed the action */
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      index: true,
    },

    /**
     * Denormalized actor info — so audit reports don't need to join.
     * Captured at the time of the event (immutable snapshot).
     */
    actorSnapshot: {
      email:    { type: String },
      fullName: { type: String },
      role:     { type: String },  // their OrganizationMember role at time of action
    },

    // ------------------------------------------------------------------
    // Action — WHAT happened?
    // ------------------------------------------------------------------

    action: {
      type: String,
      required: true,
      enum: AUDIT_ACTIONS,
      index: true,
    },

    category: {
      type: String,
      required: true,
      enum: AUDIT_CATEGORIES,
      index: true,
    },

    // ------------------------------------------------------------------
    // Target — WHAT was affected?
    // ------------------------------------------------------------------

    /** The Mongoose model name: "Organization", "Journal", "JournalLine", etc. */
    targetModel: {
      type: String,
      required: true,
    },

    /** The _id of the document that was created/updated/deleted */
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
    },

    /**
     * Human-readable label for the target, captured at event time.
     * Examples: "JE-2026-0001847", "Fund I", "alice@example.com"
     * Makes audit logs readable without joins.
     */
    targetLabel: {
      type: String,
    },

    // ------------------------------------------------------------------
    // Change detail — WHAT specifically changed?
    // ------------------------------------------------------------------

    /**
     * For CREATE: the full document snapshot (or key fields only).
     * For UPDATE: only the fields that changed, with before/after values.
     * For DELETE: the full document snapshot for recovery.
     *
     * Structure for UPDATE:
     * {
     *   "status": { before: "DRAFT", after: "POSTED" },
     *   "totalDebitFunctional": { before: "0", after: "1000000.00" }
     * }
     *
     * Structure for CREATE:
     * {
     *   "name": { after: "Fund III" },
     *   "baseCurrency": { after: "USD" }
     * }
     *
     * IMPORTANT: Sensitive fields (passwords, 2FA secrets, bank account
     * numbers) must be REDACTED before writing here. The middleware
     * handles this via a redaction list.
     */
    changes: {
      type: Schema.Types.Mixed,
    },

    // ------------------------------------------------------------------
    // Context — WHY / HOW did this happen?
    // ------------------------------------------------------------------

    /**
     * Free-text description of why the change was made.
     * Optional but encouraged for accounting events.
     * Example: "Reversing JE-2026-0001847 due to incorrect FX rate"
     */
    reason: {
      type: String,
      maxlength: 1000,
    },

    /**
     * How was this action triggered?
     * Helps distinguish human actions from automated/system actions.
     */
    source: {
      type: String,
      enum: [
        "UI",           // user action in web/mobile UI
        "API",          // direct API call
        "SYSTEM",       // automated (cron, scheduler, auto-reverse)
        "MIGRATION",    // data migration script
        "IMPORT",       // CSV/bulk import
        "INTEGRATION",  // third-party integration (Plaid, QuickBooks, etc.)
      ],
      default: "UI",
    },

    /** IP address of the request (for security audit) */
    ipAddress: { type: String },

    /** User agent string (for security audit) */
    userAgent: { type: String },

    /**
     * Request correlation ID — ties this audit entry to a specific
     * API request. If one API call modifies 5 documents, all 5 audit
     * entries share the same correlationId.
     */
    correlationId: { type: String },

    // ------------------------------------------------------------------
    // Timestamp
    // ------------------------------------------------------------------

    /**
     * Explicit timestamp field (not relying on Mongoose timestamps).
     * Immutable. Set once at creation, never changed.
     * Using a dedicated field makes TTL indexes and range queries cleaner.
     */
    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
      index: true,
    },
  },
  {
    // NO timestamps: true — we use occurredAt instead.
    // This prevents any possibility of updatedAt implying mutability.
    timestamps: false,

    // Explicitly name the collection
    collection: "audittrails",

    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes — optimized for the 5 most common audit queries
// ---------------------------------------------------------------------------

/**
 * Query 1: "Show me all audit events for this organization, newest first"
 * Used in: Audit log dashboard, compliance review
 */
auditTrailSchema.index({ organizationId: 1, occurredAt: -1 });

/**
 * Query 2: "Show me all accounting events for this fund in this date range"
 * Used in: Fund audit, period-end review, auditor requests
 */
auditTrailSchema.index({ fundId: 1, category: 1, occurredAt: -1 });

/**
 * Query 3: "Show me everything this person did"
 * Used in: Security investigation, access review
 */
auditTrailSchema.index({ performedBy: 1, occurredAt: -1 });

/**
 * Query 4: "Show me the complete history of this specific document"
 * Used in: Tracing a journal's lifecycle, investigating a change
 */
auditTrailSchema.index({ targetModel: 1, targetId: 1, occurredAt: -1 });

/**
 * Query 5: "Show me all events of a specific type in this org"
 * Used in: "Show me all journal postings", "Show all role changes"
 */
auditTrailSchema.index({ organizationId: 1, action: 1, occurredAt: -1 });

/**
 * Query 6: Correlation — find all changes made in a single API request
 */
auditTrailSchema.index({ correlationId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Write-only enforcement
// ---------------------------------------------------------------------------

/**
 * BLOCK all update operations on audit trail documents.
 * Audit entries are IMMUTABLE — insert only, never modify.
 */
auditTrailSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function () {
  throw new Error("AuditTrail documents are immutable. Updates are not allowed.");
});

/**
 * BLOCK all delete operations on audit trail documents.
 * Audit entries must NEVER be deleted programmatically.
 * Only a DBA with direct DB access should be able to purge (with approval).
 */
auditTrailSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  throw new Error("AuditTrail documents are immutable. Deletes are not allowed.");
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = model("AuditTrail", auditTrailSchema);

// Also export enums for use in middleware and services
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
module.exports.AUDIT_CATEGORIES = AUDIT_CATEGORIES;
