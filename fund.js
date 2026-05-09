/**
 * ============================================================================
 * VCFO SCHEMA: Fund
 * ============================================================================
 *
 * WHAT THIS IS:
 *   An individual investment vehicle — a VC fund, PE fund, SPV, co-invest,
 *   evergreen fund, or fund-of-funds. Each Fund belongs to one Organization
 *   and has its own chart of accounts, accounting periods, and journals.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) Fund
 *   Fund (1) ──► (N) ChartOfAccounts
 *   Fund (1) ──► (N) AccountingPeriod
 *   Fund (1) ──► (N) Journal
 *   Fund (1) ──► (N) FundRole (who can access this fund)
 *
 * WHY THIS EXISTS:
 *   Old "Entity" was a god-object mixing org data with fund data.
 *   Old "FundInfo" had fund-specific fields but referenced Entity.
 *   This schema merges the fund-relevant parts of both into one clean
 *   collection. Everything org-level stays on Organization.
 *
 * ACCOUNTING RELEVANCE:
 *   - `functionalCurrency` is THE currency for this fund's books (ASC 830).
 *     All journal lines have a functional amount in this currency.
 *   - `reportingCurrency` is for consolidation into the Organization's
 *     reporting currency (usually same as functionalCurrency).
 *   - `accountingStandard` determines valuation rules, financial statement
 *     format, and CoA templates. ASC 946 = Investment Company accounting.
 *   - `fiscalYearEndMonth/Day` determines period boundaries for this fund.
 *   - `fundType` + `vehicleStructure` together determine waterfall logic,
 *     allocation methods, and regulatory requirements.
 *
 * MIGRATION SOURCE:
 *   Entity (fund-level fields) + FundInfo (merged)
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const addressSchema = new Schema(
  {
    line1:   { type: String, trim: true },
    line2:   { type: String, trim: true },
    city:    { type: String, trim: true },
    state:   { type: String, trim: true },
    zipCode: { type: String, trim: true },
    country: { type: String, trim: true, uppercase: true, maxlength: 3 },
  },
  { _id: false }
);

/**
 * Fund economics — carry, hurdle, fees, waterfall.
 * Structured sub-document so these are always grouped together.
 */
const economicsSchema = new Schema(
  {
    // Management fees
    managementFeeRate:        { type: Schema.Types.Decimal128 }, // e.g., "0.02" = 2%
    managementFeeCalcBasis:   { type: String, enum: ["COMMITTED", "INVESTED", "NET_INVESTED", "NAV", "CUSTOM"] },
    managementFeeStartDate:   { type: Date },
    managementFeeFrequency:   { type: String, enum: ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"], default: "QUARTERLY" },
    managementFeeOutsideCommitment: { type: Boolean, default: false },

    // Post-investment period fee reduction
    postInvestmentFeeRate:     { type: Schema.Types.Decimal128 },
    feeReductionDate:          { type: Date },

    // Carried interest
    carriedInterestRate:       { type: Schema.Types.Decimal128 }, // e.g., "0.20" = 20%
    secondCarriedInterestRate: { type: Schema.Types.Decimal128 },
    carryCalculationMethod:    { type: String, enum: ["WHOLE_FUND", "DEAL_BY_DEAL", "HYBRID"] },

    // Hurdle
    hurdleRate:                { type: Schema.Types.Decimal128 }, // e.g., "0.08" = 8%
    secondHurdleRate:          { type: Schema.Types.Decimal128 },
    hurdleBase:                { type: String, enum: ["COMMITTED", "CONTRIBUTED", "CUSTOM"] },

    // Catch-up & clawback
    catchUpRate:               { type: Schema.Types.Decimal128 },
    hasClawback:               { type: Boolean, default: false },

    // Waterfall
    waterfallType:             { type: String, enum: ["EUROPEAN", "AMERICAN", "CUSTOM"] },

    // GP commitment
    gpCommitmentPercent:       { type: Schema.Types.Decimal128 },
    gpCommitmentAmount:        { type: Schema.Types.Decimal128 },

    // Distribution
    distributionPolicy:        { type: String },

    // Fees notes (free text for LPA-specific language)
    feesNotes:                 { type: String, maxlength: 5000 },
  },
  { _id: false }
);

/**
 * Fund timeline — key dates in the fund lifecycle.
 */
const timelineSchema = new Schema(
  {
    dateFormed:            { type: Date },
    dateOfIncorporation:   { type: Date },
    firstClosingDate:      { type: Date },
    finalClosingDate:      { type: Date },
    activationDate:        { type: Date },
    inceptionDate:         { type: Date },
    investmentPeriodEnd:   { type: Date },
    initialFundTermDate:   { type: Date },
    plannedEndDate:        { type: Date },
    expectedEndDate:       { type: Date },
    actualEndDate:         { type: Date },
    extensionEndDate:      { type: Date },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const fundSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Parent relationship
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /** Full legal name: "VCFO Ventures Fund I, LP" */
    legalName: {
      type: String,
      required: [true, "Fund legal name is required"],
      trim: true,
      maxlength: 300,
    },

    /** Short display name: "Fund I" */
    shortName: {
      type: String,
      trim: true,
      maxlength: 100,
    },

    /**
     * URL-safe unique identifier within the organization.
     * e.g., "fund-i", "spv-acme-2026"
     */
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"],
      maxlength: 100,
    },

    /**
     * What kind of vehicle this is.
     * Determines UI, allocation logic, and regulatory treatment.
     */
    fundType: {
      type: String,
      required: true,
      enum: [
        "VENTURE_CAPITAL",
        "PRIVATE_EQUITY",
        "HEDGE_FUND",
        "REAL_ESTATE",
        "CREDIT",
        "INFRASTRUCTURE",
        "FUND_OF_FUNDS",
        "OTHER",
      ],
      default: "VENTURE_CAPITAL",
    },

    /**
     * Legal structure of the vehicle.
     */
    vehicleStructure: {
      type: String,
      required: true,
      enum: [
        "CLOSED_END_LP",        // Standard LP fund
        "EVERGREEN",            // Open-ended / perpetual
        "SPV",                  // Single-purpose vehicle
        "CO_INVEST",            // Co-investment vehicle
        "FEEDER",               // Feeder fund
        "MASTER",               // Master fund
        "GP_ENTITY",            // GP management entity
        "MGMT_COMPANY",         // Management company
      ],
      default: "CLOSED_END_LP",
    },

    /** Vintage year for benchmarking and reporting */
    vintageYear: { type: Number, min: 1950, max: 2100 },

    /** Fund number within the family: 1, 2, 3... */
    fundNumber: { type: Number },

    /** Fund family name: "VCFO Ventures" */
    fundFamily: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Accounting Configuration — CRITICAL
    // ------------------------------------------------------------------

    /**
     * The currency in which this fund maintains its books.
     * ALL journal entries in functional currency must balance.
     * This is the "functional currency" per ASC 830.
     *
     * ACCOUNTING RULE: Once set and journals exist, this should NOT change.
     * Changing functional currency requires retrospective restatement.
     */
    functionalCurrency: {
      type: String,
      required: [true, "Functional currency is required"],
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: "USD",
    },

    /**
     * Reporting currency for this fund's standalone financials.
     * Usually same as functional. Different only if the fund reports
     * in a different currency than it operates in.
     */
    reportingCurrency: {
      type: String,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: "USD",
    },

    /** Accounting standard governing this fund's financial statements */
    accountingStandard: {
      type: String,
      enum: ["US_GAAP_ASC946", "IFRS", "IND_AS", "OTHER"],
      default: "US_GAAP_ASC946",
    },

    /** Fiscal year end — may differ from org-level default */
    fiscalYearEndMonth: { type: Number, min: 1, max: 12, default: 12 },
    fiscalYearEndDay:   { type: Number, min: 1, max: 31, default: 31 },

    /**
     * Number of decimal places for this fund's reports.
     * Some funds report in whole dollars (0), some to cents (2).
     */
    reportDecimals: { type: Number, min: 0, max: 6, default: 2 },

    // ------------------------------------------------------------------
    // Economics
    // ------------------------------------------------------------------

    economics: { type: economicsSchema },

    // ------------------------------------------------------------------
    // Fund size & capital
    // ------------------------------------------------------------------

    /** Target fund size in functional currency */
    targetFundSize:     { type: Schema.Types.Decimal128 },
    /** Hard cap — maximum allowed commitments */
    hardCap:            { type: Schema.Types.Decimal128 },
    /** Current total commitments */
    totalCommitments:   { type: Schema.Types.Decimal128 },

    // ------------------------------------------------------------------
    // Legal & jurisdiction
    // ------------------------------------------------------------------

    domicile:           { type: String, trim: true, uppercase: true, maxlength: 3 },
    legalForm:          { type: String, trim: true }, // "Delaware LP", "Cayman ELP"
    registeredAddress:  { type: addressSchema },
    taxId:              { type: String, trim: true },

    // Governance
    gpName:             { type: String, trim: true },
    gpDomicile:         { type: String, trim: true, uppercase: true, maxlength: 3 },
    managementCoName:   { type: String, trim: true },
    managementCoDomicile: { type: String, trim: true, uppercase: true, maxlength: 3 },
    fundManager:        { type: String, trim: true },

    // ------------------------------------------------------------------
    // Timeline
    // ------------------------------------------------------------------

    timeline: { type: timelineSchema },

    // ------------------------------------------------------------------
    // Durations (in months)
    // ------------------------------------------------------------------

    investmentPeriodMonths:  { type: Number },
    fundTermMonths:          { type: Number },
    extensionMonths:         { type: Number },
    fundraisePeriodMonths:   { type: Number },

    // ------------------------------------------------------------------
    // Fund strategy & description
    // ------------------------------------------------------------------

    investmentStrategy:   { type: String, maxlength: 5000 },
    sectorFocus:          { type: String, maxlength: 1000 },
    geographyFocus:       { type: String, maxlength: 1000 },
    description:          { type: String, maxlength: 10000 },

    // ------------------------------------------------------------------
    // Parent fund (for feeders, SPVs, co-invests)
    // ------------------------------------------------------------------

    parentFundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
    },

    // ------------------------------------------------------------------
    // Contact
    // ------------------------------------------------------------------

    email:   { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    phone:   { type: String, trim: true },

    // ------------------------------------------------------------------
    // Branding
    // ------------------------------------------------------------------

    logo:            { type: String },
    backgroundImage: { type: String },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: [
        "SETUP",           // Initial configuration, no journals yet
        "FUNDRAISING",     // Accepting commitments
        "ACTIVE",          // Deployed, investing
        "HARVEST",         // Post-investment period
        "WIND_DOWN",       // Returning capital
        "TERMINATED",      // Fund closed
      ],
      default: "SETUP",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Feature flags (fund-level overrides)
    // ------------------------------------------------------------------

    features: {
      capitalCallAmountBreakdown: { type: Boolean, default: false },
      showCarriedInterest:        { type: Boolean, default: true },
      showManagementFees:         { type: Boolean, default: true },
      showWaivedManagementFees:   { type: Boolean, default: false },
      customCapitalStatement:     { type: Boolean, default: false },
      individualInvestments:      { type: Boolean, default: false },
      cryptoTracking:             { type: Boolean, default: false },
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "funds",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** All funds for an organization */
fundSchema.index({ organizationId: 1, status: 1 });

/** Unique slug within an organization */
fundSchema.index({ organizationId: 1, slug: 1 }, { unique: true });

/** Find feeder/SPV children of a parent fund */
fundSchema.index({ parentFundId: 1 }, { sparse: true });

/** Find by creator */
fundSchema.index({ createdBy: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(fundSchema, {
  modelName: "Fund",
  category: "FUND",
  getLabel: (doc) => doc.shortName || doc.legalName,
  redactFields: ["taxId"],
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc._id,
});

module.exports = model("Fund", fundSchema);
