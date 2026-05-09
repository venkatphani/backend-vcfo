/**
 * ============================================================================
 * VCFO SCHEMA: ComplianceRun
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The result of an AI-powered compliance check run against a fund.
 *   Each run evaluates the fund against ASC 946 rules, LPA covenants,
 *   regulatory requirements, and internal policies. Produces a list of
 *   check results with compliance status, findings, and recommendations.
 *
 * MENTAL MODEL:
 *   Fund (1) ──► (N) ComplianceRun (one per check run)
 *   ComplianceRun (0..1) ──► JobQueue (if triggered async)
 *   ComplianceRun (0..1) ──► Document (generated report)
 *
 * WHY THIS EXISTS:
 *   Fund accounting requires periodic compliance verification:
 *   - Are capital calls within commitment limits?
 *   - Are management fees calculated correctly per LPA?
 *   - Are investment concentration limits respected?
 *   - Are required LP notices being sent on time?
 *   - Is the fund compliant with ASC 946 reporting requirements?
 *
 *   Running these checks manually is error-prone. The AI agent evaluates
 *   the fund's data against rules and produces a structured report.
 *
 * ACCOUNTING RELEVANCE:
 *   - Non-compliant findings may require journal adjustments.
 *   - Compliance reports are audit deliverables.
 *   - lpDistributionBlocked can halt distributions if non-compliant.
 *   - Generated reports (markdown/PDF) are stored as Documents.
 *
 * MIGRATION SOURCE:
 *   Old schema: ComplianceRun (minor ref updates)
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
 * Individual compliance check result.
 */
const checkResultSchema = new Schema(
  {
    /** Unique check identifier: "ASC946-INV-001", "LPA-FEES-003" */
    checkId: {
      type: String,
      required: true,
    },

    /** Human-readable check description */
    checkItem: {
      type: String,
      required: true,
    },

    /** Result */
    status: {
      type: String,
      enum: ["COMPLIANT", "NON_COMPLIANT", "UNDER_REVIEW", "NOT_APPLICABLE"],
      required: true,
    },

    /** What was found */
    findings: { type: String, maxlength: 2000 },

    /** What to do about it */
    recommendation: { type: String, maxlength: 2000 },

    /** Escalation notes (who needs to act) */
    escalation: { type: String, maxlength: 1000 },

    /**
     * Category of the check.
     */
    category: {
      type: String,
      enum: [
        "INVESTMENT_LIMITS",      // Concentration, diversification
        "FEE_COMPLIANCE",         // Management fee, carry calculations
        "CAPITAL_ACTIVITY",       // Call/distribution procedural compliance
        "REPORTING",              // Reporting timeliness, completeness
        "REGULATORY",             // SEC, state regulatory
        "LPA_COVENANTS",          // LPA-specific requirements
        "TAX",                    // Tax compliance, withholding
        "VALUATION",              // Fair value methodology compliance
        "BANKING",                // Banking controls, wire verification
        "OTHER",
      ],
    },

    /** Severity if non-compliant */
    severity: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    },
  },
  { _id: false }
);

/**
 * AI token usage tracking for the compliance run.
 */
const tokenUsageSchema = new Schema(
  {
    totalInput:    { type: Number, default: 0 },
    totalOutput:   { type: Number, default: 0 },
    cacheRead:     { type: Number, default: 0 },
    cacheWrite:    { type: Number, default: 0 },
    llmCalls:      { type: Number, default: 0 },
    estimatedCost: { type: Schema.Types.Decimal128, default: "0" },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const complianceRunSchema = new Schema(
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
    // Run identity
    // ------------------------------------------------------------------

    /** Who triggered the compliance check */
    generatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    /** Which period is being checked */
    quarter: { type: String, trim: true },

    /** Date range for the check */
    fromDate: { type: Date },
    toDate:   { type: Date },

    /** Which compliance agent/model was used */
    agentType: {
      type: String,
      default: "ASC_946",
    },

    // ------------------------------------------------------------------
    // Results
    // ------------------------------------------------------------------

    /**
     * Overall compliance status.
     */
    overallStatus: {
      type: String,
      enum: ["COMPLIANT", "NON_COMPLIANT", "UNDER_REVIEW", "PENDING"],
      default: "PENDING",
    },

    /** Individual check results */
    checks: {
      type: [checkResultSchema],
      default: [],
    },

    /** Summary counts */
    totalChecks:        { type: Number, default: 0 },
    compliantCount:     { type: Number, default: 0 },
    nonCompliantCount:  { type: Number, default: 0 },
    underReviewCount:   { type: Number, default: 0 },

    /**
     * If true, distributions are blocked until compliance is resolved.
     * Can be set automatically when critical non-compliant checks are found.
     */
    lpDistributionBlocked: {
      type: Boolean,
      default: false,
    },

    // ------------------------------------------------------------------
    // Run status
    // ------------------------------------------------------------------

    runStatus: {
      type: String,
      enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED"],
      default: "RUNNING",
    },

    errorMessage: { type: String },

    /** Link to job queue if async */
    jobId: {
      type: Schema.Types.ObjectId,
      ref: "JobQueue",
      default: null,
    },

    // ------------------------------------------------------------------
    // Generated report
    // ------------------------------------------------------------------

    /** Link to generated compliance report document */
    reportDocumentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },

    // ------------------------------------------------------------------
    // AI usage tracking
    // ------------------------------------------------------------------

    tokenUsage: {
      type: tokenUsageSchema,
      default: () => ({}),
    },

    /** Number of REPL/tool calls the agent made */
    agentCallCount: {
      type: Number,
      default: 0,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "complianceruns",

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

/** All compliance runs for a fund */
complianceRunSchema.index({ fundId: 1, createdAt: -1 });

/** Org-wide compliance dashboard */
complianceRunSchema.index({ organizationId: 1, overallStatus: 1 });

/** Find runs by quarter */
complianceRunSchema.index({ fundId: 1, quarter: 1 });

/** Job linkage */
complianceRunSchema.index({ jobId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(complianceRunSchema, {
  modelName: "ComplianceRun",
  category: "ACCOUNTING",
  getLabel: (doc) => `Compliance ${doc.quarter || doc.createdAt?.toISOString?.()?.slice(0, 10) || ""}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("ComplianceRun", complianceRunSchema);
