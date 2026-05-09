/**
 * ============================================================================
 * VCFO SCHEMA: Investment
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A portfolio company or individual investment asset held by a Fund.
 *   Tracks cost basis, current valuation, instrument details, and
 *   ownership. Multiple investment "rounds" or "tranches" in the same
 *   company are separate Investment records (or use lots on JournalLine).
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) Investment
 *   Investment (1) ──► (N) JournalLine (via JournalLine.investmentId)
 *   Investment (1) ──► (N) Valuation (fair value marks over time)
 *
 *   An Investment's current book value is NOT stored here — it's derived
 *   from JournalLines tagged with this Investment's _id. This schema stores
 *   the DEAL TERMS and COMPANY INFO. The accounting system tracks the VALUE.
 *
 * WHY SEPARATE FROM VALUATION:
 *   Investment = what we bought and the terms. Static after purchase.
 *   Valuation = what it's worth now. Changes every quarter/period.
 *   Keeping them separate means valuations are an append-only time series
 *   while the investment record stays stable.
 *
 * ACCOUNTING RELEVANCE:
 *   - `instrumentType` determines GL account placement:
 *       EQUITY → 1210 Equity Securities at FV
 *       CONVERTIBLE_NOTE → 1220 Convertible Notes at FV
 *       SAFE → 1230 SAFEs at FV
 *       DEBT → 1240 Debt Securities
 *   - `costBasis` is the initial amount recorded (may differ from cash paid
 *     if there are transaction costs or OID).
 *   - Schedule of Investments = all Investment records + latest Valuation
 *     per investment, grouped by sector/stage/geography.
 *   - Realized gain/loss on exit = exit proceeds - cost basis (from journal lines)
 *
 * FOR LLM MATH:
 *   Cost basis = SUM(JournalLine.functionalDebit) WHERE investmentId = this
 *     AND account.accountSubClass = "INVESTMENT_AT_FV" AND journal.journalType = "INVESTMENT_PURCHASE"
 *   Current FV = latest Valuation.fairValue WHERE investmentId = this
 *   Unrealized gain/loss = Current FV - Cost basis
 *   Realized gain/loss = SUM(lines on REALIZED_GAIN/REALIZED_LOSS accounts) WHERE investmentId = this
 *   MOIC = (Current FV + Realized proceeds) / Cost basis
 *
 * MIGRATION SOURCE:
 *   Old schemas: FundPortCoInfo + FundPortCoInvestmentInfo
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
 * Instrument terms — the financial instrument details.
 * What kind of security and its key terms.
 */
const instrumentTermsSchema = new Schema(
  {
    // Convertible note terms
    principalAmount:       { type: Schema.Types.Decimal128 },
    interestRate:          { type: Schema.Types.Decimal128 },
    maturityDate:          { type: Date },
    conversionDiscount:    { type: Schema.Types.Decimal128 }, // e.g., 0.20 = 20% discount
    conversionCap:         { type: Schema.Types.Decimal128 }, // valuation cap

    // SAFE terms
    safeType:              { type: String, enum: ["PRE_MONEY", "POST_MONEY", "MFN", "OTHER"] },
    valuationCap:          { type: Schema.Types.Decimal128 },
    discountRate:          { type: Schema.Types.Decimal128 },

    // Equity terms
    pricePerShare:         { type: Schema.Types.Decimal128 },
    sharesAcquired:        { type: Schema.Types.Decimal128 },
    fullyDilutedPercent:   { type: Schema.Types.Decimal128 }, // ownership at time of investment
    shareClass:            { type: String, trim: true }, // "Series A Preferred", "Common"
    liquidationPreference: { type: Schema.Types.Decimal128 },
    liquidationMultiple:   { type: Schema.Types.Decimal128 },
    participating:         { type: Boolean },
    antiDilution:          { type: String, enum: ["BROAD_WEIGHTED_AVG", "NARROW_WEIGHTED_AVG", "FULL_RATCHET", "NONE"] },

    // Debt terms
    couponRate:            { type: Schema.Types.Decimal128 },
    paymentFrequency:      { type: String, enum: ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "BULLET"] },
    securityType:          { type: String, trim: true }, // "Senior Secured", "Subordinated"

    // Warrant terms
    warrantShares:         { type: Schema.Types.Decimal128 },
    warrantStrikePrice:    { type: Schema.Types.Decimal128 },
    warrantExpiry:         { type: Date },
  },
  { _id: false }
);

/**
 * Exit/disposition details — filled when the investment is exited.
 */
const exitSchema = new Schema(
  {
    exitType: {
      type: String,
      enum: [
        "IPO",
        "ACQUISITION",
        "SECONDARY_SALE",
        "BUYBACK",
        "MERGER",
        "WRITE_OFF",
        "LIQUIDATION",
        "PARTIAL_EXIT",
        "CONVERSION",
        "OTHER",
      ],
    },
    exitDate:        { type: Date },
    exitProceeds:    { type: Schema.Types.Decimal128 },
    exitCurrency:    { type: String, uppercase: true, maxlength: 3 },
    acquirerName:    { type: String, trim: true },
    exitNotes:       { type: String, maxlength: 5000 },
    escrowAmount:    { type: Schema.Types.Decimal128 }, // held back in escrow
    escrowReleaseDate: { type: Date },
    realizedGainLoss: { type: Schema.Types.Decimal128 }, // computed at exit
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const investmentSchema = new Schema(
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
    // Company identity
    // ------------------------------------------------------------------

    /** Company or asset name: "Acme Corp", "BTC Holdings" */
    companyName: {
      type: String,
      required: [true, "Company/asset name is required"],
      trim: true,
      maxlength: 300,
    },

    /** Short display name for reports */
    shortName: {
      type: String,
      trim: true,
      maxlength: 100,
    },

    slug: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 100,
    },

    /** Company website */
    website: { type: String, trim: true },

    /** Brief description of the company */
    description: { type: String, maxlength: 5000 },

    // ------------------------------------------------------------------
    // Classification
    // ------------------------------------------------------------------

    /**
     * Type of financial instrument.
     * Determines GL account mapping and valuation methodology.
     */
    instrumentType: {
      type: String,
      required: true,
      enum: [
        "EQUITY",              // Common or preferred stock
        "CONVERTIBLE_NOTE",    // Convertible promissory note
        "SAFE",                // Simple Agreement for Future Equity
        "DEBT",                // Straight debt / fixed income
        "WARRANT",             // Warrant / option
        "LP_INTEREST",         // LP interest in another fund (FoF)
        "REAL_ESTATE",         // Real estate asset
        "CRYPTO",              // Digital asset / cryptocurrency
        "OTHER",
      ],
      default: "EQUITY",
    },

    /** Sector/industry classification */
    sector: { type: String, trim: true, maxlength: 100 },

    /** Sub-sector */
    subSector: { type: String, trim: true, maxlength: 100 },

    /** Company stage at time of investment */
    stage: {
      type: String,
      enum: [
        "PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C",
        "SERIES_D_PLUS", "GROWTH", "LATE_STAGE", "PRE_IPO",
        "PUBLIC", "BUYOUT", "OTHER",
      ],
    },

    /** Geography / HQ location */
    geography: { type: String, trim: true, maxlength: 100 },
    country:   { type: String, trim: true, uppercase: true, maxlength: 3 },

    // ------------------------------------------------------------------
    // Investment details
    // ------------------------------------------------------------------

    /** Date the investment was made (cash out the door) */
    investmentDate: {
      type: Date,
      required: [true, "Investment date is required"],
    },

    /** Total amount invested (in transaction currency) */
    investmentAmount: {
      type: Schema.Types.Decimal128,
      required: [true, "Investment amount is required"],
    },

    /** Currency of the investment */
    investmentCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: "USD",
    },

    /**
     * Cost basis in the fund's functional currency.
     * May differ from investmentAmount if:
     *   - FX conversion applies
     *   - Transaction costs are capitalized
     *   - Original issue discount
     */
    costBasis: {
      type: Schema.Types.Decimal128,
    },

    /** FX rate at time of investment (if cross-currency) */
    fxRateAtInvestment: { type: Schema.Types.Decimal128 },

    /** Transaction/legal costs capitalized into cost basis */
    transactionCosts: { type: Schema.Types.Decimal128 },

    /** Round / tranche identifier: "Series A", "Bridge 2", "Tranche 1" */
    roundName: { type: String, trim: true, maxlength: 100 },

    /** Investment terms */
    terms: { type: instrumentTermsSchema },

    // ------------------------------------------------------------------
    // Holding period tracking
    // ------------------------------------------------------------------

    /** For funds holding across multiple vehicles/SPVs */
    coInvestors: [{
      fundId:    { type: Schema.Types.ObjectId, ref: "Fund" },
      fundName:  { type: String },
      amount:    { type: Schema.Types.Decimal128 },
    }],

    /** Board seat / observer right */
    boardSeat:       { type: Boolean, default: false },
    boardObserver:   { type: Boolean, default: false },
    boardMemberName: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Exit
    // ------------------------------------------------------------------

    exit: { type: exitSchema },

    // ------------------------------------------------------------------
    // Follow-on tracking
    // ------------------------------------------------------------------

    /** Links follow-on investments to the original */
    initialInvestmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
    },

    /** Total invested across all tranches (denormalized for reports) */
    totalInvestedAllTranches: { type: Schema.Types.Decimal128 },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      required: true,
      enum: [
        "PIPELINE",           // Under evaluation, not yet invested
        "COMMITTED",          // Committed but cash not deployed
        "ACTIVE",             // Invested and held
        "MARKED_DOWN",        // Written down but still held
        "PARTIALLY_EXITED",   // Some proceeds received
        "EXITED",             // Fully exited
        "WRITTEN_OFF",        // Fully written off
        "CONVERTED",          // Convertible note / SAFE converted to equity
      ],
      default: "ACTIVE",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    tags: [{ type: String, trim: true, lowercase: true }],

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "investments",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = [
          "investmentAmount", "costBasis", "fxRateAtInvestment",
          "transactionCosts", "totalInvestedAllTranches",
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

/** All investments for a fund */
investmentSchema.index({ fundId: 1, status: 1 });

/** Unique company per fund per round (prevent duplicate entries) */
investmentSchema.index({ fundId: 1, companyName: 1, roundName: 1 }, { unique: true });

/** Find across org (firm-level portfolio view) */
investmentSchema.index({ organizationId: 1, status: 1 });

/** Sector/stage filtering for analytics */
investmentSchema.index({ fundId: 1, sector: 1 });
investmentSchema.index({ fundId: 1, stage: 1 });

/** Follow-on chain */
investmentSchema.index({ initialInvestmentId: 1 }, { sparse: true });

/** Company search across all funds */
investmentSchema.index({ organizationId: 1, companyName: 1 });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

investmentSchema.virtual("name").get(function () {
  return this.shortName || this.companyName;
});

investmentSchema.virtual("isExited").get(function () {
  return ["EXITED", "WRITTEN_OFF"].includes(this.status);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(investmentSchema, {
  modelName: "Investment",
  category: "INVESTMENT",
  getLabel: (doc) => `${doc.companyName}${doc.roundName ? " - " + doc.roundName : ""}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Investment", investmentSchema);
