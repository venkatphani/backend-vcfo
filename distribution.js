/**
 * ============================================================================
 * VCFO SCHEMA: Distribution
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A distribution event from a Fund to its LPs. When the fund returns
 *   capital (from exits, income, etc.), each LP receives their share.
 *   This schema records the distribution itself, the per-LP breakdown,
 *   and the economic characterization of the distribution.
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) Distribution
 *   Distribution (1) ──► (N) allocations (embedded, one per Investor)
 *   Distribution (1) ──► (1) Journal (auto-generated when posted)
 *   Each allocation ──► JournalLine (tagged with investorId)
 *
 * THE FLOW:
 *   1. Fund exits an investment or has distributable income
 *   2. GP creates a Distribution in DRAFT status
 *   3. System computes per-LP allocations (may involve waterfall calc)
 *   4. GP reviews and approves
 *   5. On APPROVED → DISTRIBUTED: journal entry created:
 *        DR  3200 Partner Capital - Distributions (LP Alice)  $600,000
 *        DR  3200 Partner Capital - Distributions (LP Bob)    $400,000
 *        CR  1100 Cash                                        $1,000,000
 *   6. Wire instructions sent, funds distributed
 *
 * DISTRIBUTION CHARACTER:
 *   Each LP's distribution is characterized as:
 *   - Return of Capital (ROC): returning what they put in
 *   - Realized Gain: profit from investment exits
 *   - Carried Interest: GP's performance fee
 *   - Interest/Dividend Income: portfolio company income
 *   - Other Income: misc income
 *
 *   The character matters for LP tax reporting (K-1 / tax statements).
 *   The old TRANSACTION_TYPE_PARTNER enum maps to these characters.
 *
 * ACCOUNTING RELEVANCE:
 *   - Distributions REDUCE LP capital account balances.
 *   - The debit side hits equity accounts (3200 Partner Capital - Distributions).
 *   - The credit side hits cash (1100).
 *   - Carried interest distributions split between GP and LPs per waterfall.
 *   - Escrow holdbacks are tracked separately (escrow sub-account).
 *   - Recallable distributions increase unfunded commitment (can be called again).
 *
 * FOR LLM MATH:
 *   Distribution per LP = based on waterfall calculation or pro-rata
 *   Total distributed to date = SUM(all Distribution allocations for LP WHERE status != CANCELLED)
 *   DPI (Distributed to Paid-In) = total distributions / total contributions per LP
 *   TVPI = (current NAV + total distributions) / total contributions
 *
 * MIGRATION SOURCE:
 *   Old schemas: FundCapitalDistribution + Transaction (DISTRIBUTION type)
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
 * Per-LP distribution allocation.
 * Replaces old Transaction schema for distribution entries.
 */
const distributionAllocationSchema = new Schema(
  {
    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      required: true,
    },

    /** Denormalized for fast reads */
    investorName: { type: String },

    /** Total distribution to this LP in fund functional currency */
    distributionAmount: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    /**
     * Economic character breakdown — critical for LP tax reporting.
     * Sum of all character amounts should equal distributionAmount.
     */
    character: {
      returnOfCapital:     { type: Schema.Types.Decimal128, default: "0" },
      realizedGain:        { type: Schema.Types.Decimal128, default: "0" },
      realizedLoss:        { type: Schema.Types.Decimal128, default: "0" },
      unrealizedGain:      { type: Schema.Types.Decimal128, default: "0" },
      unrealizedLoss:      { type: Schema.Types.Decimal128, default: "0" },
      interestIncome:      { type: Schema.Types.Decimal128, default: "0" },
      dividendIncome:      { type: Schema.Types.Decimal128, default: "0" },
      carriedInterest:     { type: Schema.Types.Decimal128, default: "0" },
      managementFeeRebate: { type: Schema.Types.Decimal128, default: "0" },
      otherIncome:         { type: Schema.Types.Decimal128, default: "0" },
      withholdingTax:      { type: Schema.Types.Decimal128, default: "0" },
    },

    /** Amount held back in escrow */
    escrowAmount:      { type: Schema.Types.Decimal128, default: "0" },
    escrowReleaseDate: { type: Date },

    /** Is this distribution recallable? */
    isRecallable: { type: Boolean, default: false },
    recalledAmount: { type: Schema.Types.Decimal128 },
    recalledDate:   { type: Date },

    /** Net amount after escrow and withholding */
    netAmount: { type: Schema.Types.Decimal128 },

    /** Wire reference once sent */
    wireReference: { type: String, trim: true },
    sentDate:      { type: Date },

    /** Per-LP status */
    status: {
      type: String,
      enum: [
        "PENDING",       // Approved but not yet wired
        "PROCESSING",    // Wire initiated
        "DISTRIBUTED",   // Funds sent
        "PARTIALLY_RECALLED", // Some amount recalled
        "RECALLED",      // Fully recalled
        "HELD",          // Held (regulatory or dispute)
        "OFFSET",        // Offset against capital call
      ],
      default: "PENDING",
    },

    notes: { type: String, maxlength: 500 },
  },
  { _id: true }
);

/**
 * Distribution source — what generated the distributable cash.
 */
const distributionSourceSchema = new Schema(
  {
    sourceType: {
      type: String,
      required: true,
      enum: [
        "INVESTMENT_EXIT",       // Full exit of portfolio company
        "PARTIAL_EXIT",          // Partial sale
        "DIVIDEND",              // Dividend from portfolio company
        "INTEREST",              // Interest income
        "ESCROW_RELEASE",        // Release from escrow
        "FEE_REBATE",            // Management fee offset/rebate
        "RETURN_OF_CAPITAL",     // Return of unused committed capital
        "RECALLABLE_RETURN",     // Return of capital that can be recalled
        "OTHER",
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

const distributionSchema = new Schema(
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
    // Distribution identity
    // ------------------------------------------------------------------

    /**
     * Sequential distribution number per fund.
     * Format: "DIST-2026-001"
     */
    distributionNumber: {
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

    /** Date the distribution is effective */
    distributionDate: {
      type: Date,
      required: [true, "Distribution date is required"],
    },

    /** Date the distribution notice is sent to LPs */
    noticeDate: { type: Date },

    /** Expected wire date */
    paymentDate: { type: Date },

    /** Which fiscal quarter */
    fiscalQuarter: {
      type: String,
      enum: ["Q1", "Q2", "Q3", "Q4"],
    },

    fiscalYear: { type: Number },

    // ------------------------------------------------------------------
    // Amounts
    // ------------------------------------------------------------------

    /** Total distribution amount across all LPs */
    totalDistributionAmount: {
      type: Schema.Types.Decimal128,
      required: [true, "Total distribution amount is required"],
    },

    /** Total escrow holdback across all LPs */
    totalEscrowAmount: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    /** Net distributable (total - escrow) */
    totalNetAmount: {
      type: Schema.Types.Decimal128,
    },

    // ------------------------------------------------------------------
    // Sources — what generated this distributable cash
    // ------------------------------------------------------------------

    sources: [distributionSourceSchema],

    /**
     * Allocation method.
     * PRO_RATA: based on ownership %
     * WATERFALL: based on fund waterfall calculation
     * CUSTOM: manually allocated
     */
    allocationMethod: {
      type: String,
      enum: ["PRO_RATA", "WATERFALL", "CUSTOM"],
      default: "PRO_RATA",
    },

    // ------------------------------------------------------------------
    // Per-LP allocations
    // ------------------------------------------------------------------

    allocations: [distributionAllocationSchema],

    // ------------------------------------------------------------------
    // Waterfall context (if allocationMethod = WATERFALL)
    // ------------------------------------------------------------------

    waterfall: {
      /** Which tier of the waterfall this distribution reaches */
      currentTier: {
        type: String,
        enum: [
          "RETURN_OF_CAPITAL",
          "PREFERRED_RETURN",
          "GP_CATCH_UP",
          "CARRIED_INTEREST_SPLIT",
        ],
      },
      /** Total contributions returned to date (used for waterfall calc) */
      cumulativeContributions: { type: Schema.Types.Decimal128 },
      /** Total distributions to date before this one */
      cumulativeDistributions: { type: Schema.Types.Decimal128 },
      /** Preferred return accrued but unpaid */
      accruedPreferredReturn:  { type: Schema.Types.Decimal128 },
      /** GP carried interest in this distribution */
      gpCarriedInterest:       { type: Schema.Types.Decimal128 },
      /** Detailed calculation notes */
      calculationNotes:        { type: String, maxlength: 5000 },
    },

    // ------------------------------------------------------------------
    // Journal linkage
    // ------------------------------------------------------------------

    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    // ------------------------------------------------------------------
    // Document linkage
    // ------------------------------------------------------------------

    /** Distribution notice PDF */
    noticeDocId: { type: Schema.Types.ObjectId },

    /** Source document from firm-level */
    sourceActivityId: {
      type: Schema.Types.ObjectId,
      ref: "Activity",
      default: null,
    },

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
        "APPROVED",           // Approved by GP
        "NOTICE_SENT",        // Distribution notice sent to LPs
        "PROCESSING",         // Wires being processed
        "PARTIALLY_DISTRIBUTED", // Some LPs received funds
        "DISTRIBUTED",        // All LPs received funds
        "CANCELLED",          // Distribution cancelled
      ],
      default: "DRAFT",
    },

    approvedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    approvedAt: { type: Date },

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
    collection: "distributions",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = ["totalDistributionAmount", "totalEscrowAmount", "totalNetAmount"];
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

/** All distributions for a fund by status */
distributionSchema.index({ fundId: 1, status: 1, distributionDate: -1 });

/** Unique distribution number per fund */
distributionSchema.index({ fundId: 1, distributionNumber: 1 }, { unique: true, sparse: true });

/** Journal linkage */
distributionSchema.index({ journalId: 1 }, { sparse: true });

/** Date range queries */
distributionSchema.index({ fundId: 1, distributionDate: -1 });

/** Source activity lookup */
distributionSchema.index({ sourceActivityId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(distributionSchema, {
  modelName: "Distribution",
  category: "CAPITAL_ACTIVITY",
  getLabel: (doc) => doc.distributionNumber || `DIST-DRAFT-${doc._id}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Distribution", distributionSchema);
