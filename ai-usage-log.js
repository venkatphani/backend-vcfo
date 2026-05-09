/**
 * ============================================================================
 * VCFO SCHEMA: AiUsageLog
 * ============================================================================
 *
 * WHAT THIS IS:
 *   Tracks every AI/LLM API call made by the platform. Records tokens
 *   consumed, cost, duration, model used, and what triggered the call.
 *   Used for billing, usage analytics, cost optimization, and audit.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) AiUsageLog
 *   Any AI operation (chat, extraction, compliance, reconciliation)
 *   creates one or more AiUsageLog entries.
 *
 * WHY THIS EXISTS:
 *   - Track AI costs per org/fund for billing.
 *   - Monitor which AI features are most used.
 *   - Debug failed AI operations.
 *   - Audit trail for AI-assisted accounting decisions.
 *   - Usage limits and throttling.
 *
 * MIGRATION SOURCE:
 *   Old schema: AiUsageLog (minor ref updates)
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const aiUsageLogSchema = new Schema(
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

    // ------------------------------------------------------------------
    // Operation identity
    // ------------------------------------------------------------------

    /** Human-readable task name: "Parse invoice", "Generate K-1 report" */
    taskName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },

    /**
     * What type of AI operation was this?
     */
    usageType: {
      type: String,
      required: true,
      enum: [
        "CHAT",                  // General AI chat
        "DOCUMENT_CHAT",         // Chat about a specific document
        "DOCUMENT_PARSE",        // AI document extraction/parsing
        "COMPLIANCE_CHECK",      // Compliance run
        "JOURNAL_ENTRY",         // AI-assisted journal creation
        "REPORT_GENERATION",     // AI report generation
        "RECONCILIATION",        // Bank reconciliation AI
        "WATERFALL_CALC",        // Waterfall calculation
        "FEE_CALCULATION",       // Management fee calculation
        "CLASSIFICATION",        // Document classification
        "SKILL_MAP",             // Skill/capability mapping
        "OTHER",
      ],
      index: true,
    },

    // ------------------------------------------------------------------
    // Token tracking
    // ------------------------------------------------------------------

    inputTokens: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    outputTokens: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    /** Auto-computed: inputTokens + outputTokens */
    totalTokens: {
      type: Number,
      min: 0,
      default: 0,
    },

    /** Cache read tokens (if applicable) */
    cacheReadTokens: {
      type: Number,
      min: 0,
      default: 0,
    },

    /** Cache write tokens (if applicable) */
    cacheWriteTokens: {
      type: Number,
      min: 0,
      default: 0,
    },

    // ------------------------------------------------------------------
    // Cost
    // ------------------------------------------------------------------

    /** Estimated cost in USD */
    costUsd: {
      type: Schema.Types.Decimal128,
      default: "0",
    },

    // ------------------------------------------------------------------
    // Timing
    // ------------------------------------------------------------------

    startedAt: {
      type: Date,
      required: true,
    },

    endedAt: {
      type: Date,
    },

    /** Auto-computed: endedAt - startedAt */
    durationMs: {
      type: Number,
    },

    // ------------------------------------------------------------------
    // Model info
    // ------------------------------------------------------------------

    /** Which LLM model was used */
    model: {
      type: String,
      default: "claude-sonnet-4-20250514",
    },

    /** Provider: anthropic, openai, etc. */
    provider: {
      type: String,
      default: "anthropic",
    },

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["IN_PROGRESS", "COMPLETED", "FAILED"],
      default: "IN_PROGRESS",
      index: true,
    },

    errorMessage: { type: String },

    // ------------------------------------------------------------------
    // Who / what triggered this
    // ------------------------------------------------------------------

    triggeredBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    /**
     * What entity is this AI call related to?
     * Polymorphic reference — referenceModel tells you which collection.
     */
    referenceId: {
      type: Schema.Types.ObjectId,
    },

    referenceModel: {
      type: String, // "Fund", "ComplianceRun", "Journal", "Document", etc.
    },

    /** Link to the conversation if this was a chat operation */
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "AiConversation",
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "aiusagelogs",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        if (ret.costUsd) ret.costUsd = ret.costUsd.toString();
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Pre-save: auto-compute totalTokens and durationMs
// ---------------------------------------------------------------------------

aiUsageLogSchema.pre("save", function (next) {
  this.totalTokens = (this.inputTokens || 0) + (this.outputTokens || 0);
  if (this.startedAt && this.endedAt) {
    this.durationMs = new Date(this.endedAt) - new Date(this.startedAt);
  }
  next();
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Org usage dashboard (most common query) */
aiUsageLogSchema.index({ organizationId: 1, createdAt: -1 });

/** Usage by type */
aiUsageLogSchema.index({ organizationId: 1, usageType: 1, createdAt: -1 });

/** Cost tracking by month */
aiUsageLogSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

/** Reference entity lookup */
aiUsageLogSchema.index({ referenceModel: 1, referenceId: 1 }, { sparse: true });

/** Conversation linkage */
aiUsageLogSchema.index({ conversationId: 1 }, { sparse: true });

module.exports = model("AiUsageLog", aiUsageLogSchema);
