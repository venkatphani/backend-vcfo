/**
 * ============================================================================
 * VCFO SCHEMA: Valuation
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A fair value mark for a specific Investment at a specific date.
 *   Append-only time series — one record per investment per valuation date.
 *   Each valuation may trigger a VALUATION_ADJUSTMENT journal entry to
 *   record unrealized gain/loss.
 *
 * MENTAL MODEL:
 *   Investment (1) ──► (N) Valuation (one per period)
 *   Valuation (1) ──► (0..1) Journal (unrealized gain/loss entry)
 *
 *   The LATEST valuation per investment is the "current fair value"
 *   used in financial statements and the Schedule of Investments.
 *
 * WHY SEPARATE FROM INVESTMENT:
 *   Investment stores deal terms (static after purchase).
 *   Valuation stores what it's worth (changes every period).
 *   Keeping them separate gives a clean time series:
 *     Date        | Investment    | Fair Value  | Change
 *     2025-12-31  | Acme Corp     | $5,000,000  | —
 *     2026-03-31  | Acme Corp     | $6,200,000  | +$1,200,000
 *     2026-06-30  | Acme Corp     | $5,800,000  | -$400,000
 *
 * ACCOUNTING RELEVANCE:
 *   - ASC 946 requires investments carried at fair value.
 *   - Fair value changes create unrealized gain/loss entries:
 *       DR  1200 Investments at FV       1,200,000
 *       CR  6100 Unrealized Gain         1,200,000
 *   - At period-end, the system compares previous valuation to new valuation
 *     and auto-generates the adjustment journal.
 *   - `valuationMethod` documents the ASC 820 fair value hierarchy level.
 *
 * FOR LLM MATH:
 *   Unrealized gain/loss for period =
 *     current period FV - previous period FV (for existing holdings)
 *     OR current period FV - cost basis (for new investments in the period)
 *
 *   Schedule of Investments at period-end:
 *     For each active Investment:
 *       Cost = Investment.costBasis
 *       FV = latest Valuation.fairValue WHERE valuationDate <= periodEndDate
 *       Unrealized = FV - Cost
 *
 *   To get the latest valuation:
 *     db.valuations.findOne({ investmentId, valuationDate: { $lte: asOfDate } })
 *       .sort({ valuationDate: -1 })
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const valuationSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      required: true,
      index: true,
    },

    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      required: true,
      index: true,
    },

    /** Which accounting period this valuation relates to */
    periodId: {
      type: Schema.Types.ObjectId,
      ref: "AccountingPeriod",
    },

    // ------------------------------------------------------------------
    // Valuation
    // ------------------------------------------------------------------

    /** The date this valuation is as-of (typically period-end date) */
    valuationDate: {
      type: Date,
      required: [true, "Valuation date is required"],
    },

    /**
     * Fair value in the fund's functional currency.
     * This is what goes on the balance sheet.
     */
    fairValue: {
      type: Schema.Types.Decimal128,
      required: [true, "Fair value is required"],
    },

    /**
     * Fair value in the investment's original currency
     * (if different from functional).
     */
    fairValueLocal: {
      type: Schema.Types.Decimal128,
    },

    /** Currency of the local fair value */
    localCurrency: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 3,
    },

    /** FX rate used for conversion */
    fxRate: { type: Schema.Types.Decimal128 },

    /**
     * The previous valuation (or cost basis if first mark).
     * Stored for easy delta computation without querying previous record.
     */
    previousValue: {
      type: Schema.Types.Decimal128,
    },

    /**
     * Unrealized gain/loss = fairValue - previousValue
     * Pre-computed for fast reporting.
     */
    unrealizedChange: {
      type: Schema.Types.Decimal128,
    },

    // ------------------------------------------------------------------
    // Valuation methodology (ASC 820 fair value hierarchy)
    // ------------------------------------------------------------------

    /**
     * ASC 820 fair value level:
     *   LEVEL_1: Quoted prices in active markets (public stocks)
     *   LEVEL_2: Observable inputs (comparable transactions, market multiples)
     *   LEVEL_3: Unobservable inputs (DCF, internal models) — most VC/PE
     */
    fairValueLevel: {
      type: String,
      enum: ["LEVEL_1", "LEVEL_2", "LEVEL_3"],
      default: "LEVEL_3",
    },

    /**
     * Valuation methodology used.
     */
    valuationMethod: {
      type: String,
      enum: [
        "MARKET_APPROACH",       // Comparable companies / transactions
        "INCOME_APPROACH",       // DCF, expected cash flows
        "COST_APPROACH",         // Recent transaction / cost basis
        "LAST_ROUND",           // Most recent financing round price
        "CALIBRATION",          // Calibrated to initial transaction
        "OPTION_PRICING",       // OPM / Black-Scholes backsolve
        "PROBABILITY_WEIGHTED", // Probability-weighted scenarios (PWERM)
        "NET_ASSET_VALUE",      // NAV (for fund-of-funds)
        "THIRD_PARTY",          // External appraiser
        "WRITE_OFF",            // Written to zero
        "OTHER",
      ],
    },

    /** Supporting metrics used in valuation */
    metrics: {
      revenue:           { type: Schema.Types.Decimal128 }, // LTM or projected
      revenueMultiple:   { type: Schema.Types.Decimal128 },
      ebitda:            { type: Schema.Types.Decimal128 },
      ebitdaMultiple:    { type: Schema.Types.Decimal128 },
      grossMargin:       { type: Schema.Types.Decimal128 },
      arr:               { type: Schema.Types.Decimal128 }, // Annual Recurring Revenue
      arrMultiple:       { type: Schema.Types.Decimal128 },
      discountRate:      { type: Schema.Types.Decimal128 },
      dlom:              { type: Schema.Types.Decimal128 }, // Discount for Lack of Marketability
      impliedValuation:  { type: Schema.Types.Decimal128 }, // Enterprise/equity value
    },

    // ------------------------------------------------------------------
    // Journal linkage
    // ------------------------------------------------------------------

    /**
     * The journal entry that recorded the unrealized gain/loss.
     * Null if no adjustment needed (same value as previous period).
     */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    // ------------------------------------------------------------------
    // Approval
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["DRAFT", "UNDER_REVIEW", "APPROVED", "POSTED"],
      default: "DRAFT",
    },

    preparedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    approvedAt: { type: Date },

    // ------------------------------------------------------------------
    // Supporting documentation
    // ------------------------------------------------------------------

    /** Valuation report or supporting document */
    documentId: { type: Schema.Types.ObjectId },

    /** Notes / rationale for this valuation */
    notes: {
      type: String,
      maxlength: 5000,
    },

    // ------------------------------------------------------------------
    // Source
    // ------------------------------------------------------------------

    /** Where did this valuation come from? */
    source: {
      type: String,
      enum: [
        "INTERNAL",          // GP team valued internally
        "THIRD_PARTY",       // External valuation firm
        "AUDITOR",           // Audit firm provided value
        "MARKET_DATA",       // Public market data
        "FUND_ADMIN",        // Fund administrator provided
        "AI_SUGGESTED",      // AI-generated initial estimate
        "IMPORT",            // Imported from external system
      ],
      default: "INTERNAL",
    },

    /** Name of the valuation firm (if THIRD_PARTY) */
    valuationFirm: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "valuations",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = [
          "fairValue", "fairValueLocal", "fxRate",
          "previousValue", "unrealizedChange",
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

/** Unique valuation per investment per date (one mark per period) */
valuationSchema.index(
  { fundId: 1, investmentId: 1, valuationDate: 1 },
  { unique: true }
);

/** Latest valuation lookup (most common query) */
valuationSchema.index({ investmentId: 1, valuationDate: -1 });

/** All valuations for a fund at a point in time (SOI report) */
valuationSchema.index({ fundId: 1, valuationDate: 1, status: 1 });

/** Journal linkage */
valuationSchema.index({ journalId: 1 }, { sparse: true });

/** Period-based lookup */
valuationSchema.index({ fundId: 1, periodId: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(valuationSchema, {
  modelName: "Valuation",
  category: "INVESTMENT",
  getLabel: (doc) => `Valuation ${doc.valuationDate?.toISOString?.()?.slice(0, 10) || ""}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Valuation", valuationSchema);
