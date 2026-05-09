/**
 * ============================================================================
 * VCFO SCHEMA: Activity
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The firm-level intake and workflow system. When any accounting event
 *   needs to happen — capital call, distribution, expense, investment,
 *   valuation mark, bank statement — it enters the system as an Activity.
 *   Think of it as a work item / task / ticket that flows through
 *   review → approval → journal generation.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) Activity
 *   Activity (0..1) ──► Fund (assigned during review)
 *   Activity (0..1) ──► Journal (generated on approval)
 *   Activity (0..1) ──► CapitalCall / Distribution / Investment / Valuation
 *
 *   The GP drops a document (invoice, bank statement, SPA, call notice)
 *   at the org level → system creates an Activity → reviewer assigns
 *   it to a fund → approves → journals auto-generate.
 *
 * WHY THIS EXISTS:
 *   The old Activity schema had 30+ types crammed into one model with
 *   polymorphic fields (managementFeesData, syndicationCosts, exitData,
 *   etc.). The new design simplifies: Activity is a workflow container.
 *   The domain-specific data lives in the linked schemas (CapitalCall,
 *   Distribution, Investment, Valuation, etc.).
 *
 * THE FLOW:
 *   1. INTAKE → Activity created (DRAFT)
 *      - Manual entry, document upload, email forward, bank feed
 *   2. TRIAGE → Assign to fund, set type, link source docs
 *   3. REVIEW → Accountant reviews, AI suggests journal entries
 *   4. APPROVE → GP/Admin approves
 *   5. POST → Journals auto-generated, Activity marked COMPLETED
 *   6. Or: REJECTED / CANCELLED / ON_HOLD
 *
 * ACCOUNTING RELEVANCE:
 *   - Activities are the ORIGIN of most journal entries.
 *   - The audit trail can trace: Activity → Journal → JournalLines.
 *   - "Who approved this expense?" → Activity.approvedBy.
 *   - "What document supports this entry?" → Activity.attachments.
 *   - Period-end checklist: "Are all Activities for this period resolved?"
 *
 * MIGRATION SOURCE:
 *   Old schema: Activity (the one with 30+ type enum)
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Comment / review note on an activity.
 */
const commentSchema = new Schema(
  {
    authorId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
    },
    authorName: { type: String }, // denormalized
    content: { type: String, required: true, maxlength: 5000 },
    action: {
      type: String,
      enum: ["COMMENT", "APPROVE", "REJECT", "REQUEST_INFO", "REASSIGN"],
      default: "COMMENT",
    },
  },
  { _id: true, timestamps: true }
);

/**
 * File attachment on an activity.
 */
const attachmentSchema = new Schema(
  {
    fileId:     { type: Schema.Types.ObjectId },
    filename:   { type: String, trim: true },
    mimeType:   { type: String, trim: true },
    sizeBytes:  { type: Number },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    uploadedAt: { type: Date, default: Date.now },
    /** What kind of document is this? */
    docType: {
      type: String,
      enum: [
        "INVOICE",
        "RECEIPT",
        "BANK_STATEMENT",
        "SUBSCRIPTION_AGREEMENT",
        "SIDE_LETTER",
        "SPA",               // Share Purchase Agreement
        "TERM_SHEET",
        "VALUATION_REPORT",
        "TAX_FORM",
        "CALL_NOTICE",
        "DISTRIBUTION_NOTICE",
        "LEGAL",
        "OTHER",
      ],
    },
  },
  { _id: true }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const activitySchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope — FIRM LEVEL (fund assigned during triage)
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    /**
     * Which fund this activity relates to.
     * May be null on creation (firm-level intake) and assigned during triage.
     * Some activities span multiple funds (split across linked activities).
     */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Activity type
    // ------------------------------------------------------------------

    /**
     * What kind of accounting event is this?
     *
     * Maps from old Activity.type enum:
     *   "CAPITAL CALL" → CAPITAL_CALL
     *   "DISTRIBUTION" → DISTRIBUTION
     *   "NEW INVESTMENT" → INVESTMENT
     *   "FOLLOW-ON INVESTMENT" → INVESTMENT
     *   "VALUATION" → VALUATION
     *   "MANAGEMENT FEE" → MANAGEMENT_FEE
     *   "EXPENSE - PROFESSIONAL FEES" → EXPENSE
     *   "EXPENSE - OPERATING EXPENSE" → EXPENSE
     *   "BANK STATEMENT" → BANK_RECONCILIATION
     *   "EXIT" → EXIT
     *   etc.
     */
    activityType: {
      type: String,
      required: true,
      enum: [
        // Capital activity
        "CAPITAL_CALL",
        "DISTRIBUTION",

        // Investment lifecycle
        "INVESTMENT",          // new or follow-on
        "EXIT",                // full or partial exit
        "VALUATION",           // fair value mark

        // Fund operations
        "MANAGEMENT_FEE",      // fee calculation & allocation
        "EXPENSE",             // fund expense (legal, audit, admin, etc.)
        "INCOME",              // interest, dividend, other income

        // Banking
        "BANK_RECONCILIATION", // bank statement processing
        "WIRE_TRANSFER",       // outgoing wire

        // LP operations
        "INVESTOR_ONBOARDING", // new LP setup
        "COMMITMENT_CHANGE",   // LP commitment increase/decrease
        "TRANSFER",            // LP interest transfer

        // Period-end
        "PERIOD_CLOSE",        // period-end checklist / closing entries
        "FX_REVALUATION",      // FX reval at period-end
        "CARRY_CALCULATION",   // carried interest calculation

        // Administrative
        "JOURNAL_ENTRY",       // manual journal entry
        "DOCUMENT_REVIEW",     // document that needs classification
        "OTHER",
      ],
    },

    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /** Short title for the activity */
    title: {
      type: String,
      required: [true, "Activity title is required"],
      trim: true,
      maxlength: 300,
    },

    /** Longer description */
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
    },

    /**
     * Sequential activity number per org.
     * Format: "ACT-2026-001"
     */
    activityNumber: {
      type: String,
      trim: true,
    },

    /** Priority for task management */
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /** When the underlying event happened (invoice date, call date, etc.) */
    eventDate: { type: Date },

    /** When this needs to be completed */
    dueDate: { type: Date },

    /** Which fiscal quarter this relates to */
    fiscalQuarter: {
      type: String,
      enum: ["Q1", "Q2", "Q3", "Q4"],
    },

    fiscalYear: { type: Number },

    // ------------------------------------------------------------------
    // Amounts
    // ------------------------------------------------------------------

    /** Primary amount (if applicable — call amount, expense amount, etc.) */
    amount: { type: Schema.Types.Decimal128 },
    currency: { type: String, uppercase: true, trim: true, maxlength: 3 },

    // ------------------------------------------------------------------
    // Linked schemas (the actual domain objects)
    // ------------------------------------------------------------------

    /**
     * Once this activity generates a domain object, link it here.
     * Only ONE of these should be set per activity.
     */
    linkedCapitalCallId: {
      type: Schema.Types.ObjectId,
      ref: "CapitalCall",
      default: null,
    },
    linkedDistributionId: {
      type: Schema.Types.ObjectId,
      ref: "Distribution",
      default: null,
    },
    linkedInvestmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
    },
    linkedValuationId: {
      type: Schema.Types.ObjectId,
      ref: "Valuation",
      default: null,
    },
    linkedInvestorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      default: null,
    },

    // ------------------------------------------------------------------
    // Journal linkage
    // ------------------------------------------------------------------

    /** The final posted journal generated from this activity */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** Draft journal (before approval) for preview */
    draftJournalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    // ------------------------------------------------------------------
    // Assignment & workflow
    // ------------------------------------------------------------------

    /** Who is responsible for this activity */
    assigneeId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      default: null,
    },

    /** Who created it */
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Approval
    // ------------------------------------------------------------------

    approvedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 1000 },

    // ------------------------------------------------------------------
    // Comments & attachments
    // ------------------------------------------------------------------

    comments: [commentSchema],
    attachments: [attachmentSchema],

    // ------------------------------------------------------------------
    // AI assistance
    // ------------------------------------------------------------------

    /** AI-suggested journal entries or classification */
    aiSuggestion: { type: Schema.Types.Mixed },

    /** AI confidence in its suggestion (0-1) */
    aiConfidence: { type: Number, min: 0, max: 1 },

    /** Was this activity auto-created by AI (document parsing, email, etc.)? */
    isAiGenerated: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Source tracking
    // ------------------------------------------------------------------

    /** How did this activity enter the system? */
    source: {
      type: String,
      enum: [
        "MANUAL",              // GP typed it in
        "DOCUMENT_UPLOAD",     // dropped a file
        "EMAIL_FORWARD",       // forwarded an email
        "BANK_FEED",           // from bank transaction sync
        "CALENDAR",            // scheduled recurring activity
        "SYSTEM",              // auto-generated (period-end, carry calc)
        "API",                 // external system
        "IMPORT",              // bulk CSV import
      ],
      default: "MANUAL",
    },

    /** If from bank feed, link to the bank transaction */
    bankTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BankTransaction",
      default: null,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      required: true,
      enum: [
        "DRAFT",               // Just created, not yet triaged
        "PENDING_ASSIGNMENT",  // Needs fund assignment
        "ASSIGNED",            // Assigned to someone
        "IN_REVIEW",           // Being reviewed
        "PENDING_APPROVAL",    // Submitted for approval
        "APPROVED",            // Approved, ready for posting
        "COMPLETED",           // Journals posted, done
        "REJECTED",            // Rejected by approver
        "ON_HOLD",             // Paused
        "CANCELLED",           // Cancelled
      ],
      default: "DRAFT",
    },

    completedAt: { type: Date },

    // ------------------------------------------------------------------
    // Recurrence (for scheduled activities like quarterly mgmt fees)
    // ------------------------------------------------------------------

    recurrence: {
      isRecurring:   { type: Boolean, default: false },
      frequency:     { type: String, enum: ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"] },
      nextDueDate:   { type: Date },
      parentActivityId: { type: Schema.Types.ObjectId, ref: "Activity" }, // link to recurring template
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    tags: [{ type: String, trim: true, lowercase: true }],

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "activities",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        if (ret.amount) ret.amount = ret.amount.toString();
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Primary dashboard query: all activities for an org by status */
activitySchema.index({ organizationId: 1, status: 1, createdAt: -1 });

/** Fund-specific activity view */
activitySchema.index({ fundId: 1, status: 1, createdAt: -1 });

/** Activity type filter */
activitySchema.index({ organizationId: 1, activityType: 1, status: 1 });

/** Assignee's task list */
activitySchema.index({ assigneeId: 1, status: 1 });

/** Unique activity number per org */
activitySchema.index({ organizationId: 1, activityNumber: 1 }, { unique: true, sparse: true });

/** Journal linkage */
activitySchema.index({ journalId: 1 }, { sparse: true });

/** Due date / overdue tracking */
activitySchema.index({ organizationId: 1, dueDate: 1, status: 1 });

/** Bank transaction linkage */
activitySchema.index({ bankTransactionId: 1 }, { sparse: true });

/** Linked domain objects */
activitySchema.index({ linkedCapitalCallId: 1 }, { sparse: true });
activitySchema.index({ linkedDistributionId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

activitySchema.virtual("isOverdue").get(function () {
  if (!this.dueDate) return false;
  if (["COMPLETED", "CANCELLED", "REJECTED"].includes(this.status)) return false;
  return this.dueDate < new Date();
});

activitySchema.virtual("isResolved").get(function () {
  return ["COMPLETED", "CANCELLED", "REJECTED"].includes(this.status);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(activitySchema, {
  modelName: "Activity",
  category: "DOCUMENT", // firm-level document/workflow
  getLabel: (doc) => doc.activityNumber || doc.title,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Activity", activitySchema);
