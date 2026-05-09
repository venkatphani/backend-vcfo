/**
 * ============================================================================
 * VCFO SCHEMA: ManagementFeeCalc
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The per-LP, per-quarter management fee calculation result. When the
 *   system runs a fee calculation for a fund, it produces one record per
 *   investor per quarter. This is the detailed breakdown showing how the
 *   fee was computed — basis, rate, proration, catch-up, side letter
 *   overrides — and links to the journal entry that books it.
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) ManagementFeeCalc (one per investor per quarter)
 *   ManagementFeeCalc (N) ──► (1) Investor
 *   ManagementFeeCalc (0..1) ──► Journal (fee journal entry)
 *   ManagementFeeCalc (0..1) ──► CapitalCall (if fee is called from LPs)
 *
 * THE FEE CALCULATION FLOW:
 *   1. User triggers fee calculation (or scheduled via JobQueue)
 *   2. For each investor in the fund:
 *      a. Determine fee basis (committed capital, contributed, NAV, etc.)
 *      b. Check for side letter rate override (Investor.feeTerms)
 *      c. Apply proration if LP joined mid-quarter
 *      d. Handle catch-up fees for subsequent closings
 *      e. Create ManagementFeeCalc record
 *   3. Generate summary journal entry:
 *        DR  5100 Management Fee Expense (per LP)  [investorId: alice]
 *        CR  2200 Management Fee Payable            [total]
 *      Or if called from LPs:
 *        DR  1100 Cash (via CapitalCall)
 *        CR  3100 Partner Capital - Contributions (per LP)
 *
 * WHY SEPARATE FROM INVESTOR:
 *   Fee terms (the RATE and RULES) live on Investor.feeTerms.
 *   Fee calculations (the RESULT for each quarter) live here.
 *   This is a time series — one record per quarter per LP — not something
 *   that belongs embedded on the Investor document.
 *
 * ACCOUNTING RELEVANCE:
 *   - Management fees are a major fund expense.
 *   - LP capital account statements show fees allocated per partner.
 *   - Fee calculations must be auditable: what basis, what rate, any
 *     overrides, any proration — all stored here.
 *   - Catch-up fees for subsequent close LPs are common and complex.
 *   - Side letter fee waivers/offsets must be tracked.
 *
 * FOR LLM MATH:
 *   Quarterly fee per LP =
 *     feeBasis × (appliedRate / 4) × prorationFactor
 *   Where:
 *     feeBasis = commitment (or contributed capital, or NAV per LPA)
 *     appliedRate = Investor.feeTerms.managementFeeRate OR Fund.economics.managementFeeRate
 *     prorationFactor = proratedDays / totalDaysInQuarter (if prorated)
 *
 *   Total fund fees for quarter = SUM(all ManagementFeeCalc.feeAmount WHERE quarter = Q)
 *
 *   Inception-to-date fees per LP =
 *     SUM(all ManagementFeeCalc.feeAmount WHERE investorId = LP)
 *
 * MIGRATION SOURCE:
 *   Old schemas: ManagementFeeQuarterly + ManagementFeesFundCapital + ManagementFeeSchedule
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const managementFeeCalcSchema = new Schema(
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

    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      required: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Quarter identification
    // ------------------------------------------------------------------

    /**
     * Quarter identifier: "2026-Q1", "2026-Q2", etc.
     * Format: YYYY-QN (sortable, unique per fund per investor).
     */
    quarter: {
      type: String,
      required: [true, "Quarter is required"],
      trim: true,
    },

    quarterStartDate: {
      type: Date,
      required: true,
    },

    quarterEndDate: {
      type: Date,
      required: true,
    },

    fiscalYear: {
      type: Number,
    },

    // ------------------------------------------------------------------
    // Fee basis — what the fee is calculated on
    // ------------------------------------------------------------------

    /**
     * What metric is the fee based on?
     * Determined by Fund.economics.managementFeeCalcBasis or LP side letter.
     */
    calculationBasis: {
      type: String,
      required: true,
      enum: [
        "COMMITTED_CAPITAL",       // Most common for PE/VC
        "CONTRIBUTED_CAPITAL",     // Post-investment period
        "INVESTED_CAPITAL",        // Capital deployed into investments
        "NET_INVESTED_CAPITAL",    // Invested minus returned capital
        "NAV",                     // Net Asset Value (hedge fund style)
        "COST_BASIS",              // Cost basis of investments
        "FAIR_MARKET_VALUE",       // FMV of portfolio
        "CUSTOM",                  // Custom formula
      ],
      default: "COMMITTED_CAPITAL",
    },

    /**
     * The dollar amount used as the fee basis for this quarter.
     * E.g., if basis = COMMITTED_CAPITAL, this is the LP's commitment amount.
     */
    feeBasisAmount: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    /**
     * Distributions subtracted from basis (if LPA requires it).
     * E.g., "contributed capital less distributions" = commitment - distributionOffset.
     */
    distributionOffset: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    // ------------------------------------------------------------------
    // Rate — what rate was applied
    // ------------------------------------------------------------------

    /**
     * Annual management fee rate applied (as decimal).
     * E.g., 0.02 = 2%, 0.015 = 1.5%.
     */
    appliedRate: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    /**
     * Where did the rate come from?
     */
    rateSource: {
      type: String,
      enum: [
        "FUND_DEFAULT",      // From Fund.economics.managementFeeRate
        "SIDE_LETTER",       // From Investor.feeTerms.managementFeeRate
        "EXEMPT",            // LP is fee-exempt (feeTerms.mgmtFeeWaived)
        "REDUCED",           // Reduced rate (step-down after investment period)
        "CUSTOM",            // Custom rate
      ],
      default: "FUND_DEFAULT",
    },

    /** If rate came from side letter, note which one */
    sideLetterRef: {
      type: String,
      trim: true,
    },

    // ------------------------------------------------------------------
    // Fee amounts
    // ------------------------------------------------------------------

    /**
     * The actual fee for this quarter.
     * = feeBasisAmount × (appliedRate / 4) × prorationFactor
     */
    feeAmount: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    /**
     * Catch-up fees owed by LPs who joined at subsequent closings.
     * They owe fees from fund inception to their closing date.
     */
    catchUpFeeAmount: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    /**
     * Fee offset amount (from portfolio company fees, advisory fees, etc.).
     * Reduces the fee charged to this LP.
     */
    feeOffsetAmount: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    /**
     * Net fee after offset.
     * = feeAmount + catchUpFeeAmount - feeOffsetAmount
     */
    netFeeAmount: {
      type: Schema.Types.Decimal128,
    },

    /**
     * Inception-to-date cumulative fees for this LP.
     * Running total through end of this quarter.
     */
    inceptionToDateFees: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    // ------------------------------------------------------------------
    // Proration (for partial quarters)
    // ------------------------------------------------------------------

    /**
     * Is the fee prorated for this quarter?
     * True if LP joined mid-quarter or fund terminated mid-quarter.
     */
    isProrated: {
      type: Boolean,
      default: false,
    },

    /** Number of days the fee applies in this quarter */
    proratedDays: {
      type: Number,
    },

    /** Total days in the quarter (for proration denominator) */
    totalDaysInQuarter: {
      type: Number,
    },

    // ------------------------------------------------------------------
    // Rate step-down tracking
    // ------------------------------------------------------------------

    /**
     * Did the rate change mid-quarter?
     * E.g., investment period ended and rate dropped from 2% to 1.5%.
     */
    isSplitQuarter: {
      type: Boolean,
      default: false,
    },

    /** Pre-step-down rate (if split quarter) */
    preSplitRate: { type: Schema.Types.Decimal128 },

    /** Pre-split days */
    preSplitDays: { type: Number },

    /** Post-step-down rate (if split quarter) */
    postSplitRate: { type: Schema.Types.Decimal128 },

    /** Post-split days */
    postSplitDays: { type: Number },

    // ------------------------------------------------------------------
    // Fee schedule / formula (replaces ManagementFeeSchedule)
    // ------------------------------------------------------------------

    /**
     * The formula or schedule used for this calculation.
     * Stored per-record for audit trail — if the schedule changes,
     * historical records still show what formula was applied.
     */
    formulaSnapshot: {
      type: Schema.Types.Mixed,
    },

    // ------------------------------------------------------------------
    // Journal linkage
    // ------------------------------------------------------------------

    /** The journal entry that booked this fee */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** If fee was collected via capital call, link it */
    capitalCallId: {
      type: Schema.Types.ObjectId,
      ref: "CapitalCall",
      default: null,
    },

    // ------------------------------------------------------------------
    // Calculation metadata
    // ------------------------------------------------------------------

    /** When was this calculation run? */
    calculatedAt: {
      type: Date,
      default: Date.now,
    },

    /** Who triggered the calculation? */
    calculatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    /** Which job queue entry produced this? */
    jobId: {
      type: Schema.Types.ObjectId,
      ref: "JobQueue",
      default: null,
    },

    /** Status of this fee record */
    status: {
      type: String,
      enum: [
        "CALCULATED",       // Computed but not yet posted
        "POSTED",           // Journal entry created
        "WAIVED",           // Fee waived for this LP/quarter
        "ADJUSTED",         // Manually adjusted
        "REVERSED",         // Fee reversed
      ],
      default: "CALCULATED",
    },

    /** Notes / override reason */
    notes: {
      type: String,
      maxlength: 1000,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "managementfeecalcs",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = [
          "feeBasisAmount", "distributionOffset", "appliedRate",
          "feeAmount", "catchUpFeeAmount", "feeOffsetAmount",
          "netFeeAmount", "inceptionToDateFees",
          "preSplitRate", "postSplitRate",
        ];
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

/** Unique: one fee calc per investor per quarter per fund */
managementFeeCalcSchema.index(
  { fundId: 1, investorId: 1, quarter: 1 },
  { unique: true }
);

/** All fee calcs for a fund in a quarter (for summary/totals) */
managementFeeCalcSchema.index({ fundId: 1, quarter: 1, status: 1 });

/** All fee history for an investor (LP capital account detail) */
managementFeeCalcSchema.index({ investorId: 1, quarter: 1 });

/** Org-wide fee overview */
managementFeeCalcSchema.index({ organizationId: 1, quarter: 1 });

/** Journal linkage */
managementFeeCalcSchema.index({ journalId: 1 }, { sparse: true });

/** Capital call linkage */
managementFeeCalcSchema.index({ capitalCallId: 1 }, { sparse: true });

/** Job tracking */
managementFeeCalcSchema.index({ jobId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(managementFeeCalcSchema, {
  modelName: "ManagementFeeCalc",
  category: "ACCOUNTING",
  getLabel: (doc) => `Fee ${doc.quarter}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("ManagementFeeCalc", managementFeeCalcSchema);
