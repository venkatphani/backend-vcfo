/**
 * ============================================================================
 * VCFO SCHEMA: JobQueue
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A generic async job queue for long-running operations. When a task
 *   takes too long for a synchronous API response — fee calculations,
 *   carry calculations, FX revaluations, bulk imports, report generation —
 *   it gets queued as a JobQueue record and processed asynchronously.
 *
 * MENTAL MODEL:
 *   User triggers action → JobQueue record created (QUEUED)
 *   Worker picks up job → status → IN_PROGRESS
 *   Worker finishes → status → COMPLETED or FAILED
 *   UI polls JobQueue status for progress updates.
 *
 * WHY GENERIC (NOT SEPARATE PER JOB TYPE):
 *   The old system had ManagementFeeQueue specifically for fee calculations.
 *   But carry calculations, FX reval, report generation, and bulk imports
 *   all need the same pattern: queue → process → complete/fail → notify.
 *   One schema handles all of them. `jobType` distinguishes the work.
 *
 * ACCOUNTING RELEVANCE:
 *   - Fee calculations affect LP capital accounts.
 *   - Carry calculations affect GP compensation and LP distributions.
 *   - FX revaluations affect all foreign currency positions.
 *   - All of these produce journal entries when complete.
 *   - The job record provides audit trail: who triggered, when, result.
 *
 * MIGRATION SOURCE:
 *   Old schema: ManagementFeeQueue
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const jobQueueSchema = new Schema(
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
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Job identity
    // ------------------------------------------------------------------

    /**
     * What kind of job is this?
     */
    jobType: {
      type: String,
      required: true,
      enum: [
        "MANAGEMENT_FEE_CALC",     // Calculate management fees for a fund
        "CARRY_CALCULATION",       // Calculate carried interest
        "FX_REVALUATION",          // Period-end FX revaluation
        "VALUATION_BATCH",         // Batch valuation updates
        "CAPITAL_CALL_ALLOC",      // Compute capital call allocations
        "DISTRIBUTION_ALLOC",      // Compute distribution allocations
        "REPORT_GENERATION",       // Generate financial reports
        "BULK_IMPORT",             // Bulk data import (CSV, etc.)
        "BULK_JOURNAL_POST",       // Post multiple journals
        "PERIOD_CLOSE",            // Period-end closing process
        "COMPLIANCE_CHECK",        // Run compliance checks
        "DATA_MIGRATION",          // Schema migration job
        "DOCUMENT_PROCESSING",     // AI document parsing batch
        "BANK_SYNC",               // Bank account sync
        "EXPORT",                  // Data export job
        "OTHER",
      ],
    },

    /** Human-readable description */
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------

    status: {
      type: String,
      required: true,
      enum: [
        "QUEUED",          // Submitted, waiting for worker
        "IN_PROGRESS",     // Worker is processing
        "COMPLETED",       // Successfully finished
        "FAILED",          // Failed with error
        "CANCELLED",       // Cancelled by user
        "RETRYING",        // Failed, retrying
      ],
      default: "QUEUED",
      index: true,
    },

    // ------------------------------------------------------------------
    // Input / Output
    // ------------------------------------------------------------------

    /**
     * Input parameters for the job.
     * Structure depends on jobType:
     *
     * MANAGEMENT_FEE_CALC:
     *   { startDate, endDate, quarters: ["2026-Q1", "2026-Q2"] }
     *
     * FX_REVALUATION:
     *   { periodId, asOfDate }
     *
     * BULK_IMPORT:
     *   { fileId, importType, mappings }
     */
    input: {
      type: Schema.Types.Mixed,
    },

    /**
     * Output/result data from the job.
     * Structure depends on jobType:
     *
     * MANAGEMENT_FEE_CALC:
     *   { totalFees: "125000.00", partnerCount: 15, journalIds: [...] }
     *
     * REPORT_GENERATION:
     *   { documentId, reportType }
     */
    output: {
      type: Schema.Types.Mixed,
    },

    // ------------------------------------------------------------------
    // Progress tracking
    // ------------------------------------------------------------------

    /** How far along is the job? (0-100) */
    progressPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    /** Current step description for UI display */
    progressMessage: {
      type: String,
      trim: true,
    },

    /** Total items to process */
    totalItems: { type: Number },

    /** Items processed so far */
    processedItems: { type: Number, default: 0 },

    // ------------------------------------------------------------------
    // Error handling
    // ------------------------------------------------------------------

    /** Error message if FAILED */
    errorMessage: {
      type: String,
    },

    /** Full error details (stack trace, etc.) */
    errorDetails: {
      type: Schema.Types.Mixed,
      select: false,
    },

    /** How many times has this job been retried? */
    retryCount: {
      type: Number,
      default: 0,
    },

    /** Max retries before giving up */
    maxRetries: {
      type: Number,
      default: 3,
    },

    // ------------------------------------------------------------------
    // Timing
    // ------------------------------------------------------------------

    /** When the job was picked up by a worker */
    startedAt: { type: Date },

    /** When the job finished (success or failure) */
    completedAt: { type: Date },

    /** How long the job took (ms) */
    durationMs: { type: Number },

    // ------------------------------------------------------------------
    // Queue infrastructure
    // ------------------------------------------------------------------

    /** External queue message ID (SQS, Bull, etc.) */
    queueMessageId: { type: String },

    /** Which worker/instance is processing this job */
    workerId: { type: String },

    /** Priority (lower = higher priority) */
    priority: {
      type: Number,
      default: 5,
      min: 1,
      max: 10,
    },

    // ------------------------------------------------------------------
    // Who triggered it
    // ------------------------------------------------------------------

    triggeredBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    /** Was this triggered automatically (scheduled) or manually? */
    triggerSource: {
      type: String,
      enum: ["MANUAL", "SCHEDULED", "SYSTEM", "API"],
      default: "MANUAL",
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "jobqueue",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        delete ret.errorDetails;
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Worker picks up next job */
jobQueueSchema.index({ status: 1, priority: 1, createdAt: 1 });

/** All jobs for a fund by type */
jobQueueSchema.index({ fundId: 1, jobType: 1, createdAt: -1 });

/** Org-wide job dashboard */
jobQueueSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

/** Active job check (prevent duplicate runs) */
jobQueueSchema.index(
  { fundId: 1, jobType: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ["QUEUED", "IN_PROGRESS"] } } }
);

/** Who triggered what */
jobQueueSchema.index({ triggeredBy: 1, createdAt: -1 });

/** Queue message lookup */
jobQueueSchema.index({ queueMessageId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

jobQueueSchema.virtual("isActive").get(function () {
  return ["QUEUED", "IN_PROGRESS", "RETRYING"].includes(this.status);
});

jobQueueSchema.virtual("isTerminal").get(function () {
  return ["COMPLETED", "FAILED", "CANCELLED"].includes(this.status);
});

module.exports = model("JobQueue", jobQueueSchema);
