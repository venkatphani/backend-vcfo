/**
 * ============================================================================
 * VCFO SCHEMA: DealPipeline
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A deal in the investment pipeline. Tracks a potential or in-progress
 *   investment from initial screening through due diligence, approval,
 *   and closing. Once a deal closes, it becomes an Investment record.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) DealPipeline
 *   DealPipeline (0..1) ──► Investment (created when deal closes)
 *   DealPipeline (0..1) ──► Fund (which fund will invest)
 *   DealPipeline (0..1) ──► Document (supporting docs, memos)
 *
 * WHY SEPARATE FROM INVESTMENT:
 *   Investment records are DEPLOYED capital — they hit the GL.
 *   DealPipeline records are PRE-INVESTMENT — they're CRM/workflow.
 *   Many deals in the pipeline never close. Keeping them separate
 *   avoids polluting the Investment collection with dead deals.
 *
 *   When a deal closes:
 *     1. Create an Investment record (status: ACTIVE)
 *     2. Link DealPipeline.investmentId = new Investment._id
 *     3. DealPipeline.status → CLOSED_WON
 *
 * ACCOUNTING RELEVANCE:
 *   - Pipeline deals have no GL impact until closed.
 *   - Reserves (follow-on allocation) affect fund deployment strategy.
 *   - Wire confirmation status tracks actual capital movement.
 *   - Ties to financial statements flag ensures accounting picks up closed deals.
 *
 * MIGRATION SOURCE:
 *   Old schema: DealTracker
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
 * Team member assigned to this deal with a specific role.
 */
const dealRoleSchema = new Schema(
  {
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },
    /** Denormalized name for display */
    name: { type: String, trim: true },
    role: {
      type: String,
      enum: ["LEAD", "SOURCE", "APPROVER", "BOARD_MEMBER", "OBSERVER", "ANALYST"],
      default: "LEAD",
    },
    title: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Valuation snapshot at time of deal.
 */
const dealValuationSchema = new Schema(
  {
    preMoneyValuation:  { type: Schema.Types.Decimal128 },
    postMoneyValuation: { type: Schema.Types.Decimal128 },
    totalRaise:         { type: Schema.Types.Decimal128 },
    optionPoolPercent:  { type: Schema.Types.Decimal128 },
    ownershipBefore:    { type: Schema.Types.Decimal128 },
    ownershipAfter:     { type: Schema.Types.Decimal128 },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const dealPipelineSchema = new Schema(
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

    /**
     * Which fund will invest (may be null during early screening).
     */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Company identity
    // ------------------------------------------------------------------

    companyName: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
      maxlength: 300,
    },

    /** Link to existing portfolio company if follow-on */
    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
    },

    description: {
      type: String,
      maxlength: 5000,
    },

    website: { type: String, trim: true },

    sector: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Deal details
    // ------------------------------------------------------------------

    /**
     * Is this a new investment or follow-on?
     */
    dealType: {
      type: String,
      enum: [
        "INITIAL",           // First investment in company
        "FOLLOW_ON",         // Additional round in existing company
        "CO_INVEST",         // Co-investment alongside another fund
        "SECONDARY",         // Secondary purchase
        "OTHER",
      ],
      default: "INITIAL",
    },

    /**
     * Deal category / size classification.
     */
    dealCategory: {
      type: String,
      enum: [
        "SCOUT_INVESTMENT",
        "SEED",
        "ACTIVE_INVESTMENT",
        "STRATEGIC",
        "OPPORTUNISTIC",
        "OTHER",
      ],
    },

    /** Security type for this deal */
    securityType: {
      type: String,
      enum: [
        "EQUITY", "CONVERTIBLE_NOTE", "SAFE", "WARRANT",
        "DEBT", "LP_INTEREST", "OTHER",
      ],
    },

    /** Share class: "Series A Preferred", "Common", etc. */
    shareClass: {
      type: String,
      trim: true,
    },

    /** Target investment amount */
    amount: {
      type: Schema.Types.Decimal128,
    },

    /** Reserved capital for follow-on */
    reserves: {
      type: Schema.Types.Decimal128,
    },

    /** Investment currency */
    currency: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 3,
      default: "USD",
    },

    /** Deal date / expected close date */
    dealDate: { type: Date },

    // ------------------------------------------------------------------
    // Valuation
    // ------------------------------------------------------------------

    valuation: { type: dealValuationSchema },

    // ------------------------------------------------------------------
    // Team & roles
    // ------------------------------------------------------------------

    dealTeam: [dealRoleSchema],

    // ------------------------------------------------------------------
    // Approval workflow
    // ------------------------------------------------------------------

    /**
     * Deal pipeline status.
     */
    status: {
      type: String,
      required: true,
      enum: [
        "SCREENING",        // Initial review
        "DUE_DILIGENCE",    // Actively evaluating
        "TERM_SHEET",       // Term sheet issued/negotiating
        "IC_REVIEW",        // Investment committee review
        "APPROVED",         // IC approved, pending close
        "CLOSING",          // Legal/docs in progress
        "CLOSED_WON",       // Deal closed, Investment created
        "CLOSED_LOST",      // Passed or lost the deal
        "ON_HOLD",          // Paused
      ],
      default: "SCREENING",
    },

    /** Investment committee approval */
    icApproved:     { type: Boolean },
    icApprovedDate: { type: Date },
    icNotes:        { type: String, maxlength: 2000 },

    // ------------------------------------------------------------------
    // Compliance / wire tracking
    // ------------------------------------------------------------------

    wireConfirmationStatus: {
      type: String,
      enum: ["NOT_STARTED", "INSTRUCTIONS_VERIFIED", "WIRE_SENT", "WIRE_CONFIRMED"],
    },

    wireInstructionsVerified: { type: Boolean, default: false },

    stockCertificatesReceived: { type: Boolean, default: false },

    /** Does this deal tie to financial statements? */
    tiedToFinancials: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Contacts
    // ------------------------------------------------------------------

    contacts: {
      ceo:        { type: String, trim: true },
      coFounder:  { type: String, trim: true },
      financial:  { type: String, trim: true },
    },

    /** Top competitors */
    competitors: { type: String, maxlength: 1000 },

    // ------------------------------------------------------------------
    // Founder details
    // ------------------------------------------------------------------

    founderDetails: { type: String, maxlength: 2000 },
    founderOwnershipBefore: { type: Schema.Types.Decimal128 },
    founderOwnershipAfter:  { type: Schema.Types.Decimal128 },

    // ------------------------------------------------------------------
    // Documents
    // ------------------------------------------------------------------

    /** Investment memo document */
    memoDocumentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },

    /** Was this deal auto-created from a parsed document? */
    autoCreatedFromDoc: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Notes
    // ------------------------------------------------------------------

    notes: { type: String, maxlength: 5000 },
    openItems: { type: String, maxlength: 2000 },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    closedAt: { type: Date },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    tags: [{ type: String, trim: true, lowercase: true }],

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "dealpipeline",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        const d128 = ["amount", "reserves"];
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

/** Primary dashboard: all deals for an org by status */
dealPipelineSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

/** Fund-specific pipeline */
dealPipelineSchema.index({ fundId: 1, status: 1 });

/** Company search */
dealPipelineSchema.index({ organizationId: 1, companyName: 1 });

/** Link to investment (find deal that created this investment) */
dealPipelineSchema.index({ investmentId: 1 }, { sparse: true });

/** Deal type filter */
dealPipelineSchema.index({ organizationId: 1, dealType: 1, status: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(dealPipelineSchema, {
  modelName: "DealPipeline",
  category: "INVESTMENT",
  getLabel: (doc) => doc.companyName,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("DealPipeline", dealPipelineSchema);
