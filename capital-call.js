/**
 * ============================================================================
 * VCFO SCHEMA: CapitalCall
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A capital call event for a Fund. When the GP needs money from LPs,
 *   they issue a capital call. This schema records the call itself and
 *   the per-LP allocation breakdown. Posting a capital call auto-generates
 *   journal entries in the fund's GL.
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) CapitalCall
 *   CapitalCall (1) ──► (N) allocations (embedded, one per Investor)
 *   CapitalCall (1) ──► (1) Journal (auto-generated when posted)
 *   Each allocation ──► JournalLine (tagged with investorId)
 *
 * THE FLOW:
 *   1. GP creates a CapitalCall in DRAFT status
 *   2. System computes per-LP allocations based on commitment %
 *   3. GP reviews, may adjust, and moves to APPROVED
 *   4. On APPROVED → ISSUED: call notice sent to LPs, journal created:
 *        DR  1100 Cash (or 1300 Capital Call Receivable)    $1,000,000
 *        CR  3100 Partner Capital - Contributions (LP Alice)  $600,000
 *        CR  3100 Partner Capital - Contributions (LP Bob)    $400,000
 *   5. As LPs wire money: status moves to PARTIALLY_FUNDED → FULLY_FUNDED
 *   6. If an LP doesn't pay: DEFAULTED allocations, writeOff flag
 *
 * PURPOSE BREAKDOWN:
 *   A single capital call can fund multiple purposes:
 *     - $500k for new investment in Acme Corp
 *     - $200k for management fee (Q1 2026)
 *     - $100k for fund expenses
 *     - $200k for follow-on investment in Beta Inc
 *   The `purposes` array captures this. Each purpose may reference
 *   an Investment, expense category, or fee calculation.
 *
 * ACCOUNTING RELEVANCE:
 *   - The journal is auto-generated from allocations — one credit line
 *     per LP, tagged with their investorId.
 *   - Each LP's allocation can be further broken down by purpose (investment,
 *     fees, expenses) for detailed capital account statements.
 *   - TRANSACTION_TYPE_PARTNER from old enums maps to purpose types here.
 *   - The old Transaction schema's per-LP records are now the allocations[].
 *
 * FOR LLM MATH:
 *   Call amount per LP = fund-level call amount × LP ownership %
 *   Or: LP unfunded commitment × call percentage (e.g., 10% of unfunded)
 *   Total called to date = SUM(all CapitalCall allocations for this LP WHERE status != CANCELLED)
 *   Unfunded commitment = commitment - total called + recallable amounts
 *
 * MIGRATION SOURCE:
 *   Old schemas: FundCapitalCall + Transaction (CAPITAL_CALL type)
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
 * Per-LP allocation within a capital call.
 * Replaces old Transaction schema for capital call entries.
 */
const callAllocationSchema = new Schema(
  {
    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      required: true,
    },

    /** Denormalized for fast reads */
    investorName: { type: String },

    /** This LP's share of the call in fund functional currency */
    callAmount: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    /** Breakdown of what this LP's call funds */
    purposes: [{
      purposeType: {
        type: String,
        required: true,
        enum: [
          "INVESTMENT",                   // New or follow-on investment
          "MANAGEMENT_FEE",               // Management fee
          "MANAGEMENT_FEE_CATCHUP",       // Subsequent close catch-up fees
          "ORGANIZATIONAL_EXPENSE",       // Fund formation costs
          "OPERATING_EXPENSE",            // Fund operating expenses
          "PROFESSIONAL_FEE",             // Legal, audit, tax
          "RECYCLING",                    // Reinvesting realized proceeds
          "BRIDGE_FINANCING",             // Bridge loan to fund
          "CAPITAL_RESERVE",              // Reserve for follow-ons
          "OTHER",
        ],
      },
      amount:       { type: Schema.Types.Decimal128, required: true },
      investmentId: { type: Schema.Types.ObjectId, ref: "Investment" }, // if purpose = INVESTMENT
      description:  { type: String, maxlength: 500 },
    }],

    /** When this LP's funds were received */
    receivedDate: { type: Date },
    receivedAmount: { type: Schema.Types.Decimal128 },

    /** Per-LP status tracking */
    status: {
      type: String,
      enum: [
        "PENDING",           // Call issued, awaiting payment
        "PARTIALLY_FUNDED",  // Some payment received
        "FUNDED",            // Fully funded
        "OVERDUE",           // Past due date
        "DEFAULTED",         // LP failed to fund
        "WAIVED",            // Fee waived for this LP (side letter)
        "WRITTEN_OFF",       // Default written off
        "OFFSET",            // Offset against distribution
      ],
      default: "PENDING",
    },

    /** Write-off tracking */
    writeOff: { type: Boolean, default: false },
    writeOffDate: { type: Date },
    writeOffAmount: { type: Schema.Types.Decimal128 },

    /** Notes specific to this LP's allocation */
    notes: { type: String, maxlength: 500 },
  },
  { _id: true }
);

/**
 * Purpose summary — fund-level breakdown of what the call is for.
 */
const callPurposeSchema = new Schema(
  {
    purposeType: {
      type: String,
      required: true,
      enum: [
        "INVESTMENT", "MANAGEMENT_FEE", "MANAGEMENT_FEE_CATCHUP",
        "ORGANIZATIONAL_EXPENSE", "OPERATING_EXPENSE", "PROFESSIONAL_FEE",
        "RECYCLING", "BRIDGE_FINANCING", "CAPITAL_RESERVE", "OTHER",
      ],
    },
    amount:       { type: Schema.Types.Decimal128, required: true },
    investmentId: { type: Schema.Types.ObjectId, ref: "Investment" },
    description:  { type: String, maxlength: 500 },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const capitalCallSchema = new Schema(
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
    // Call identity
    // ------------------------------------------------------------------

    /**
     * Sequential call number per fund.
     * Format: "CC-2026-001"
     */
    callNumber: {
      type: String,
      trim: true,
    },

    /** Human-readable description */
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /** Date the call notice is sent to LPs */
    callDate: {
      type: Date,
      required: [true, "Call date is required"],
    },

    /** When LP funds are due */
    dueDate: {
      type: Date,
      required: [true, "Due date is required"],
    },

    /** Which fiscal quarter this relates to (for fee calls) */
    fiscalQuarter: {
      type: String,
      enum: ["Q1", "Q2", "Q3", "Q4"],
    },

    fiscalYear: { type: Number },

    // ------------------------------------------------------------------
    // Amounts
    // ------------------------------------------------------------------

    /** Total call amount across all LPs in functional currency */
    totalCallAmount: {
      type: Schema.Types.Decimal128,
      required: [true, "Total call amount is required"],
    },

    /** What the call is for (fund-level summary) */
    purposes: [callPurposeSchema],

    /** Percentage of total commitments being called */
    callPercent: {
      type: Schema.Types.Decimal128,
    },

    /**
     * Basis for computing per-LP amounts.
     * COMMITMENT: pro-rata based on total commitment
     * UNFUNDED: pro-rata based on remaining unfunded commitment
     * CUSTOM: manually set per LP
     */
    allocationBasis: {
      type: String,
      enum: ["COMMITMENT", "UNFUNDED", "CUSTOM"],
      default: "COMMITMENT",
    },

    // ------------------------------------------------------------------
    // Per-LP allocations
    // ------------------------------------------------------------------

    allocations: [callAllocationSchema],

    // ------------------------------------------------------------------
    // Journal linkage
    // ------------------------------------------------------------------

    /** The journal entry generated by this capital call */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    // ------------------------------------------------------------------
    // Document linkage
    // ------------------------------------------------------------------

    /** Call notice PDF */
    callNoticeDocId: { type: Schema.Types.ObjectId },

    /** Source document that triggered this (firm-level upload, email, etc.) */
    sourceActivityId: {
      type: Schema.Types.ObjectId,
      ref: "Activity",
      default: null,
    },

    /** Additional attachments */
    attachments: [{
      fileId:   { type: Schema.Types.ObjectId },
      filename: { type: String },
      uploadedAt: { type: Date, default: Date.now },
    }],

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      required: true,
      enum: [
        "DRAFT",              // Being prepared
        "APPROVED",           // Approved by GP, ready to issue
        "ISSUED",             // Call notice sent to LPs
        "PARTIALLY_FUNDED",   // Some LPs have funded
        "FULLY_FUNDED",       // All LPs funded
        "OVERDUE",            // Past due date, not fully funded
        "CANCELLED",          // Call cancelled
      ],
      default: "DRAFT",
    },

    /** Approval workflow */
    approvedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    approvedAt: { type: Date },
    issuedBy:   { type: Schema.Types.ObjectId, ref: "Identity" },
    issuedAt:   { type: Date },

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
    collection: "capitalcalls",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = ["totalCallAmount", "callPercent"];
        for (const f of d128) {
          if (ret[f]) ret[f] = ret[f].toString();
        }
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** All calls for a fund by status */
capitalCallSchema.index({ fundId: 1, status: 1, callDate: -1 });

/** Unique call number per fund */
capitalCallSchema.index({ fundId: 1, callNumber: 1 }, { unique: true, sparse: true });

/** Journal linkage */
capitalCallSchema.index({ journalId: 1 }, { sparse: true });

/** Date range queries */
capitalCallSchema.index({ fundId: 1, callDate: -1 });

/** Source activity lookup */
capitalCallSchema.index({ sourceActivityId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(capitalCallSchema, {
  modelName: "CapitalCall",
  category: "CAPITAL_ACTIVITY",
  getLabel: (doc) => doc.callNumber || `CC-DRAFT-${doc._id}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("CapitalCall", capitalCallSchema);
