/**
 * ============================================================================
 * VCFO SCHEMA: Investor
 * ============================================================================
 *
 * WHAT THIS IS:
 *   An LP or GP investor in a specific Fund. Tracks their commitment,
 *   contribution/distribution history, fee terms, banking, tax, and
 *   onboarding status. One Identity can be an Investor in multiple Funds
 *   (each gets its own Investor record).
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) Investor
 *   Investor (1) ──► (N) JournalLine (via JournalLine.investorId)
 *   Investor (1) ──► (N) CapitalCall allocations
 *   Investor (1) ──► (N) Distribution allocations
 *
 *   An Investor's capital account balance is NOT stored here — it's derived
 *   from JournalLines tagged with this Investor's _id. This schema stores
 *   the COMMITMENT and TERMS. The accounting system tracks the ACTIVITY.
 *
 * WHY "INVESTOR" AND NOT "LP":
 *   - GPs also invest in funds (GP commitment). They're investors too.
 *   - "Investor" is the ASC 946 / ILPA term for anyone with a capital account.
 *   - `investorType` distinguishes LP from GP from co-investor.
 *
 * ACCOUNTING RELEVANCE:
 *   - `commitment` is the basis for capital call calculations.
 *   - `ownershipPercent` determines allocation of income/loss.
 *   - `feeTerms` override fund-level defaults (side letter economics).
 *   - Every capital account line item in the GL references `investorId`.
 *   - The LP capital account statement = all JournalLines where
 *     investorId = this._id AND account.accountClass = "EQUITY".
 *
 * FOR LLM MATH:
 *   Unfunded commitment = commitment - SUM(contributions) + SUM(recallable distributions)
 *   Ownership % = investor.commitment / fund.totalCommitments
 *   Capital account balance = SUM(JournalLine.functionalCredit - JournalLine.functionalDebit)
 *     WHERE investorId = this AND account.accountClass = "EQUITY"
 *
 * MIGRATION SOURCE:
 *   Old schemas: Role (LP fields) + FundCapitalInfo + CommitmentHistory
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
 * Fee terms — per-investor overrides (side letter economics).
 * If null/undefined, the fund-level defaults from Fund.economics apply.
 */
const feeTermsSchema = new Schema(
  {
    managementFeeRate:    { type: Schema.Types.Decimal128 }, // override fund default
    carriedInterestRate:  { type: Schema.Types.Decimal128 }, // override fund default
    hurdleRate:           { type: Schema.Types.Decimal128 }, // override fund default
    catchUpRate:          { type: Schema.Types.Decimal128 }, // override fund default
    mgmtFeeWaived:       { type: Boolean, default: false },
    mgmtFeeOffsetPercent: { type: Schema.Types.Decimal128 }, // fee offset from portfolio company fees
    coInvestRights:       { type: Boolean, default: false },
    mfnRights:            { type: Boolean, default: false }, // most favored nation
    advisoryCommittee:    { type: Boolean, default: false },
    notes:                { type: String, maxlength: 5000 }, // side letter terms in plain text
  },
  { _id: false }
);

/**
 * Banking details for distributions.
 */
const bankingSchema = new Schema(
  {
    bankName:        { type: String, trim: true },
    accountName:     { type: String, trim: true },
    accountNumber:   { type: String, trim: true },   // masked in API responses
    routingNumber:   { type: String, trim: true },   // ACH (US)
    wireRouting:     { type: String, trim: true },   // Wire (US)
    swiftCode:       { type: String, trim: true },   // International
    iban:            { type: String, trim: true },   // EU/UK
    sortCode:        { type: String, trim: true },   // UK
    currency:        { type: String, trim: true, uppercase: true, maxlength: 3 },
    intermediaryBank: { type: String, trim: true },
    specialInstructions: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false }
);

/**
 * Tax information.
 */
const taxInfoSchema = new Schema(
  {
    taxFormType:    { type: String, enum: ["W9", "W8_BEN", "W8_BEN_E", "W8_IMY", "W8_ECI", "W8_EXP", "NONE"] },
    taxId:          { type: String, trim: true },  // SSN or EIN — ALWAYS redacted in audit
    taxIdType:      { type: String, enum: ["SSN", "EIN", "ITIN", "FOREIGN"] },
    taxExempt:      { type: Boolean, default: false },
    taxExemptCode:  { type: String, trim: true },
    withholdingRate: { type: Schema.Types.Decimal128 },
    fatcaStatus:    { type: String, trim: true },
    formSubmittedAt: { type: Date },
    formVerifiedAt:  { type: Date },
    formFileId:      { type: Schema.Types.ObjectId }, // ref to document storage
  },
  { _id: false }
);

/**
 * Commitment change history entry.
 * Replaces old CommitmentHistory collection — embedded here for atomicity.
 */
const commitmentChangeSchema = new Schema(
  {
    changeType: {
      type: String,
      required: true,
      enum: ["INITIAL", "INCREASE", "DECREASE", "TRANSFER_IN", "TRANSFER_OUT"],
    },
    amount:         { type: Schema.Types.Decimal128, required: true },
    effectiveDate:  { type: Date, required: true },
    previousAmount: { type: Schema.Types.Decimal128 },
    newAmount:      { type: Schema.Types.Decimal128 },
    reason:         { type: String, maxlength: 500 },
    approvedBy:     { type: Schema.Types.ObjectId, ref: "Identity" },
    approvedAt:     { type: Date },
    status: {
      type: String,
      enum: ["PENDING", "LP_SIGNED", "COMPLETED", "REJECTED"],
      default: "PENDING",
    },
    signatureDocId: { type: String }, // e-signature reference (SignNow, DocuSign)
    documentId:     { type: Schema.Types.ObjectId }, // supporting doc ref
  },
  { _id: true, timestamps: true }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const investorSchema = new Schema(
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
    // Identity linkage (optional — not all investors are platform users)
    // ------------------------------------------------------------------

    /**
     * If this investor has a login, links to their Identity.
     * Null for investors who don't use the platform (paper LPs).
     */
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      default: null,
      index: true,
    },

    /** If they have an org membership, link for permission checks */
    organizationMemberId: {
      type: Schema.Types.ObjectId,
      ref: "OrganizationMember",
      default: null,
    },

    // ------------------------------------------------------------------
    // Investor identity
    // ------------------------------------------------------------------

    /** Legal name as it appears on subscription docs */
    legalName: {
      type: String,
      required: [true, "Investor legal name is required"],
      trim: true,
      maxlength: 300,
    },

    /** Short display name for UI: "Alice Smith" or "CalPERS" */
    displayName: {
      type: String,
      trim: true,
      maxlength: 150,
    },

    /** URL-safe identifier within the fund */
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 100,
    },

    /**
     * What type of investor.
     * Determines allocation priority, fee treatment, and reporting.
     */
    investorType: {
      type: String,
      required: true,
      enum: [
        "LP",                // Limited Partner
        "GP",                // General Partner (GP commitment)
        "GP_ENTITY",         // GP management entity investing
        "CO_INVESTOR",       // Co-invest alongside the fund
        "FEEDER",            // Feeder fund investing into master
        "FUND_OF_FUNDS",     // FoF investor
        "ANCHOR",            // Anchor/seed investor (may have special terms)
        "EMPLOYEE",          // Employee co-invest program
      ],
      default: "LP",
    },

    /**
     * Entity type for regulatory and tax purposes.
     */
    entityType: {
      type: String,
      enum: [
        "INDIVIDUAL",
        "JOINT",
        "TRUST",
        "ESTATE",
        "IRA",
        "CORPORATION",
        "LLC",
        "PARTNERSHIP",
        "PENSION_FUND",
        "ENDOWMENT",
        "FOUNDATION",
        "SOVEREIGN_WEALTH",
        "INSURANCE_COMPANY",
        "BANK",
        "REGISTERED_INVESTMENT",
        "FAMILY_OFFICE",
        "OTHER",
      ],
    },

    // ------------------------------------------------------------------
    // Contact
    // ------------------------------------------------------------------

    email:    { type: String, trim: true, lowercase: true },
    phone:    { type: String, trim: true },
    address: {
      line1:   { type: String, trim: true },
      line2:   { type: String, trim: true },
      city:    { type: String, trim: true },
      state:   { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true, uppercase: true, maxlength: 3 },
    },

    // ------------------------------------------------------------------
    // Commitment & ownership
    // ------------------------------------------------------------------

    /**
     * Total committed amount in the fund's functional currency.
     * This is the CURRENT commitment (reflects any increases/decreases).
     * History of changes is in commitmentHistory[].
     *
     * ACCOUNTING RULE: This is the contractual obligation, not what's been called.
     * Unfunded = commitment - totalContributions + recallableDistributions
     */
    commitment: {
      type: Schema.Types.Decimal128,
      required: [true, "Commitment amount is required"],
    },

    /**
     * Ownership percentage of the fund.
     * Computed: commitment / fund.totalCommitments
     * Stored for fast queries and reporting — recomputed when commitments change.
     */
    ownershipPercent: {
      type: Schema.Types.Decimal128,
    },

    /** Date the LP signed the subscription agreement */
    subscriptionDate: { type: Date },

    /** Which closing this LP came in at */
    closingDate: { type: Date },
    closingNumber: { type: Number }, // 1 = first close, 2 = second close, etc.

    /** Share class (for funds with multiple LP classes) */
    shareClass: { type: String, trim: true },

    /** Commitment history — tracks every increase/decrease */
    commitmentHistory: [commitmentChangeSchema],

    // ------------------------------------------------------------------
    // Fee terms (side letter overrides)
    // ------------------------------------------------------------------

    feeTerms: { type: feeTermsSchema },

    // ------------------------------------------------------------------
    // Banking
    // ------------------------------------------------------------------

    banking: { type: bankingSchema },

    // ------------------------------------------------------------------
    // Tax
    // ------------------------------------------------------------------

    taxInfo: { type: taxInfoSchema },

    // ------------------------------------------------------------------
    // Accreditation & compliance
    // ------------------------------------------------------------------

    accreditation: {
      isAccredited:       { type: Boolean, default: false },
      isQualifiedPurchaser: { type: Boolean, default: false },
      isQualifiedClient:  { type: Boolean, default: false },
      verifiedAt:         { type: Date },
      verifiedBy:         { type: Schema.Types.ObjectId, ref: "Identity" },
      expiresAt:          { type: Date },
      method:             { type: String, enum: ["SELF_CERTIFIED", "THIRD_PARTY", "FINANCIAL_STATEMENT", "OTHER"] },
    },

    /** ERISA status — affects investment restrictions */
    erisa: {
      isErisaPlan:        { type: Boolean, default: false },
      benefitPlanPercent: { type: Schema.Types.Decimal128 },
      isBenefitPlanInvestor: { type: Boolean, default: false },
    },

    // ------------------------------------------------------------------
    // KYC / AML
    // ------------------------------------------------------------------

    kyc: {
      status: {
        type: String,
        enum: ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "VERIFIED", "FAILED", "EXPIRED"],
        default: "NOT_STARTED",
      },
      provider:       { type: String, enum: ["PLAID", "MANUAL", "THIRD_PARTY"] },
      verificationId: { type: String }, // provider's verification ID
      verifiedAt:     { type: Date },
      expiresAt:      { type: Date },
      amlScreeningId: { type: String }, // AML/watchlist screening reference
      amlClearAt:     { type: Date },
      notes:          { type: String, maxlength: 1000 },
    },

    // ------------------------------------------------------------------
    // Onboarding
    // ------------------------------------------------------------------

    onboarding: {
      status: {
        type: String,
        enum: ["NOT_STARTED", "IN_PROGRESS", "DOCS_PENDING", "UNDER_REVIEW", "COMPLETED", "REJECTED"],
        default: "NOT_STARTED",
      },
      subscriptionDocId:  { type: Schema.Types.ObjectId }, // subscription agreement
      sideLetterDocId:    { type: Schema.Types.ObjectId }, // side letter
      completedSteps:     [{ type: String }], // ["PERSONAL_INFO", "BANKING", "TAX", "ACCREDITATION", "KYC", "SUBSCRIPTION"]
      invitedAt:          { type: Date },
      completedAt:        { type: Date },
    },

    // ------------------------------------------------------------------
    // Contacts (additional contacts for this investor)
    // ------------------------------------------------------------------

    contacts: [{
      name:     { type: String, trim: true },
      email:    { type: String, trim: true, lowercase: true },
      phone:    { type: String, trim: true },
      role:     { type: String, trim: true }, // "CFO", "Tax Advisor", "Legal Counsel"
      isPrimary: { type: Boolean, default: false },
    }],

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: [
        "PROSPECT",        // Potential investor, not yet committed
        "ONBOARDING",      // Signed but completing docs
        "ACTIVE",          // Fully committed and active
        "DEFAULTED",       // Failed to fund capital calls
        "TRANSFERRED",     // Interest transferred to another investor
        "REDEEMED",        // Redeemed (evergreen funds)
        "INACTIVE",        // Fund terminated or LP fully distributed
      ],
      default: "PROSPECT",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // LP portal preferences
    // ------------------------------------------------------------------

    portalAccess: {
      isEnabled:       { type: Boolean, default: true },
      lastAccessedAt:  { type: Date },
      notifyOnCapCall: { type: Boolean, default: true },
      notifyOnDistribution: { type: Boolean, default: true },
      notifyOnReport:  { type: Boolean, default: true },

      /**
       * GP-controlled visibility — what can this LP see in the portal?
       * Replaces old AdminControl schema (per-LP, per-section visibility).
       * If a field is false, the LP portal hides that section.
       */
      canViewDashboard:         { type: Boolean, default: true },
      canViewCapitalAccount:    { type: Boolean, default: true },
      canViewScheduleOfInvest:  { type: Boolean, default: true },
      canViewDocuments:         { type: Boolean, default: true },
      canViewReports:           { type: Boolean, default: true },
      canViewDistributions:     { type: Boolean, default: true },
      canViewCapitalCalls:      { type: Boolean, default: true },
      canViewFinancials:        { type: Boolean, default: true },
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "investors",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        // Convert Decimal128 fields
        const d128 = ["commitment", "ownershipPercent"];
        for (const f of d128) {
          if (ret[f]) ret[f] = ret[f].toString();
        }
        // Redact sensitive banking
        if (ret.banking) {
          if (ret.banking.accountNumber) {
            ret.banking.accountNumber = "****" + ret.banking.accountNumber.slice(-4);
          }
        }
        // Redact tax ID
        if (ret.taxInfo?.taxId) {
          ret.taxInfo.taxId = "****" + ret.taxInfo.taxId.slice(-4);
        }
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Unique investor per fund (by legal name) */
investorSchema.index({ fundId: 1, legalName: 1 }, { unique: true });

/** All investors for a fund by status */
investorSchema.index({ fundId: 1, status: 1 });

/** Find investor by identity (for LP portal login) */
investorSchema.index({ identityId: 1, status: 1 });

/** All investors across org (for firm-level views) */
investorSchema.index({ organizationId: 1, status: 1 });

/** Investor type filtering (all GPs, all LPs) */
investorSchema.index({ fundId: 1, investorType: 1 });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

investorSchema.virtual("name").get(function () {
  return this.displayName || this.legalName;
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(investorSchema, {
  modelName: "Investor",
  category: "INVESTOR",
  getLabel: (doc) => doc.displayName || doc.legalName,
  redactFields: [
    "banking.accountNumber",
    "banking.routingNumber",
    "banking.wireRouting",
    "banking.iban",
    "taxInfo.taxId",
    "kyc.verificationId",
    "kyc.amlScreeningId",
  ],
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Investor", investorSchema);
