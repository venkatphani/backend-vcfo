/**
 * ============================================================================
 * VCFO SCHEMA: Journal
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The header of a double-entry journal entry. Describes WHAT happened,
 *   WHEN, and its lifecycle status. The actual debits and credits live in
 *   JournalLine (separate collection).
 *
 * LIFECYCLE:
 *   DRAFT → PENDING_APPROVAL → POSTED → (optionally) REVERSED
 *                             ↘ REJECTED (back to DRAFT)
 *   VOIDED (can happen from DRAFT or PENDING_APPROVAL only)
 *
 * GOLDEN RULES:
 *   1. A POSTED journal is NEVER modified. Corrections = reversing entry.
 *   2. Journal number is assigned at POST time, not at creation.
 *   3. Before posting: SUM(debit) must equal SUM(credit) in functional ccy.
 *   4. Before posting: the target period must be OPEN (or SOFT_CLOSED for adjustments).
 *   5. All of #1-4 are enforced in a MongoDB transaction.
 *
 * FOR LLM MATH:
 *   To get all entries for a period:
 *     Journal.find({ fundId, periodId, status: "POSTED" })
 *   Then join with JournalLine on journalId.
 *
 *   totalDebitFunctional and totalCreditFunctional are pre-computed on the
 *   header for fast validation and dashboard queries. They MUST equal each other
 *   for a POSTED journal.
 *
 * MIGRATION SOURCE:
 *   Old: JournalEntry (header had single debit/credit — wrong)
 *   New: Journal is header-only. All amounts move to JournalLine.
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

// ---------------------------------------------------------------------------
// Approval sub-schema
// ---------------------------------------------------------------------------

const approvalSchema = new Schema(
  {
    identityId:  { type: Schema.Types.ObjectId, ref: "Identity", required: true },
    role:        { type: String, enum: ["PREPARER", "REVIEWER", "APPROVER"], required: true },
    action:      { type: String, enum: ["PREPARED", "REVIEWED", "APPROVED", "REJECTED"], required: true },
    comment:     { type: String, maxlength: 1000 },
    timestamp:   { type: Date, default: Date.now },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const journalSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      required: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /**
     * Sequential journal number per fund. Assigned at POST time.
     * Format: "JE-2026-0001847"
     * Null while in DRAFT/PENDING status.
     * Immutable once assigned — never reused, never changed.
     */
    journalNumber: {
      type: String,
      sparse: true,
      // unique within fund — enforced by compound index below
    },

    /**
     * What type of economic event this journal records.
     * Determines validation rules and financial statement placement.
     */
    journalType: {
      type: String,
      required: true,
      enum: [
        "STANDARD",               // Manual / general journal entry
        "CAPITAL_CALL",            // LP capital call
        "DISTRIBUTION",            // Distribution to LPs
        "INVESTMENT_PURCHASE",     // Buying a portfolio investment
        "INVESTMENT_SALE",         // Selling / exiting an investment
        "VALUATION_ADJUSTMENT",    // Fair value mark up/down
        "MGMT_FEE_ACCRUAL",       // Management fee accrual
        "CARRY_ACCRUAL",           // Carried interest accrual
        "FX_REVALUATION",          // Foreign currency revaluation
        "INTERCOMPANY",            // Between fund / GP / SPV
        "REVERSING",               // Reversal of another journal
        "ADJUSTING",               // Period-end adjusting entry
        "CLOSING",                 // Year-end closing entry
        "OPENING",                 // Opening balance entry
        "BANK_FEED",               // Auto-generated from bank feed
      ],
      default: "STANDARD",
    },

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /** When the economic event occurred (e.g., investment date, call date) */
    transactionDate: {
      type: Date,
      required: [true, "Transaction date is required"],
    },

    /** When the entry was posted to the GL (system-set at POST time) */
    postingDate: { type: Date },

    /** Which accounting period this entry belongs to */
    periodId: {
      type: Schema.Types.ObjectId,
      ref: "AccountingPeriod",
      required: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Description & reference
    // ------------------------------------------------------------------

    description: {
      type: String,
      required: [true, "Journal description is required"],
      trim: true,
      maxlength: 1000,
    },

    /** External reference (call notice #, invoice #, wire ref, etc.) */
    reference: {
      type: String,
      trim: true,
      maxlength: 200,
    },

    // ------------------------------------------------------------------
    // FX context (header-level defaults — lines can override)
    // ------------------------------------------------------------------

    /** Currency the economic event was denominated in */
    transactionCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: "USD",
    },

    /** Where FX rates came from for this entry */
    fxRateSource: {
      type: String,
      enum: ["MANUAL", "BLOOMBERG", "ECB", "OANDA", "OPEN_EXCHANGE", "INTERNAL"],
    },

    /** Date used for FX rate lookup (may differ from transaction date) */
    fxRateDate: { type: Date },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      required: true,
      enum: ["DRAFT", "PENDING_APPROVAL", "POSTED", "REVERSED", "VOIDED"],
      default: "DRAFT",
    },

    postedAt:  { type: Date },
    postedBy:  { type: Schema.Types.ObjectId, ref: "Identity" },

    // ------------------------------------------------------------------
    // Reversal linkage
    // ------------------------------------------------------------------

    /** If this journal IS a reversal, points to the original */
    reversesJournalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** If this journal WAS reversed, points to the reversal entry */
    reversedByJournalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** Should this journal auto-reverse at the start of next period? */
    isAutoReversing: { type: Boolean, default: false },
    autoReverseDate: { type: Date },

    // ------------------------------------------------------------------
    // Source linkage (what business event created this?)
    // ------------------------------------------------------------------

    /**
     * Which module generated this journal?
     * MANUAL means a human created it directly.
     */
    sourceModule: {
      type: String,
      enum: [
        "MANUAL",
        "CAPITAL_CALL",
        "DISTRIBUTION",
        "INVESTMENT",
        "VALUATION",
        "WATERFALL",
        "FX_REVAL",
        "FEE_CALC",
        "BANK_FEED",
        "IMPORT",
        "MIGRATION",
      ],
      default: "MANUAL",
    },

    /** Reference to the source document (capital call _id, distribution _id, etc.) */
    sourceDocumentId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    /** The model name of the source document for polymorphic reference */
    sourceDocumentModel: {
      type: String,
      default: null,
    },

    // ------------------------------------------------------------------
    // Approval workflow
    // ------------------------------------------------------------------

    approvals: [approvalSchema],

    // ------------------------------------------------------------------
    // Pre-computed totals (for fast validation and dashboard queries)
    // ------------------------------------------------------------------

    /** Sum of all line debits in functional currency */
    totalDebitFunctional:  { type: Schema.Types.Decimal128, default: "0" },

    /** Sum of all line credits in functional currency */
    totalCreditFunctional: { type: Schema.Types.Decimal128, default: "0" },

    /** Number of journal lines */
    lineCount: { type: Number, default: 0 },

    // ------------------------------------------------------------------
    // Attachments & tags
    // ------------------------------------------------------------------

    attachments: [{
      fileId:     { type: Schema.Types.ObjectId },
      filename:   { type: String },
      uploadedAt: { type: Date, default: Date.now },
      uploadedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    }],

    tags: [{ type: String, trim: true, lowercase: true }],

    // ------------------------------------------------------------------
    // Actors
    // ------------------------------------------------------------------

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "journals",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        // Convert Decimal128 to string
        if (ret.totalDebitFunctional) ret.totalDebitFunctional = ret.totalDebitFunctional.toString();
        if (ret.totalCreditFunctional) ret.totalCreditFunctional = ret.totalCreditFunctional.toString();
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Primary query: list journals for a fund by period */
journalSchema.index({ fundId: 1, periodId: 1, status: 1 });

/** Unique journal number within a fund */
journalSchema.index({ fundId: 1, journalNumber: 1 }, { unique: true, sparse: true });

/** Find journals by type (e.g., all FX_REVALUATION entries) */
journalSchema.index({ fundId: 1, journalType: 1, status: 1 });

/** Date range queries */
journalSchema.index({ fundId: 1, transactionDate: -1 });

/** Reversal lookups */
journalSchema.index({ reversesJournalId: 1 }, { sparse: true });
journalSchema.index({ reversedByJournalId: 1 }, { sparse: true });

/** Source document lookup (find journals generated by a capital call, etc.) */
journalSchema.index({ sourceDocumentId: 1, sourceModule: 1 }, { sparse: true });

/** Auto-reversing journals due for reversal */
journalSchema.index({ isAutoReversing: 1, autoReverseDate: 1, status: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(journalSchema, {
  modelName: "Journal",
  category: "ACCOUNTING",
  getLabel: (doc) => doc.journalNumber || `DRAFT-${doc._id}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Journal", journalSchema);
