/**
 * ============================================================================
 * VCFO SCHEMA: AccountingPeriod
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A fiscal period (month, quarter, or year) for a specific Fund.
 *   Controls when journals can be posted and enables period-end closing.
 *
 * ACCOUNTING RELEVANCE:
 *   - OPEN:        Journals can be posted freely.
 *   - SOFT_CLOSED: Only ADJUSTING entries by ACCOUNTANT+ roles.
 *   - HARD_CLOSED: No posting allowed. Period is finalized.
 *   - A journal's `periodId` must reference an OPEN or SOFT_CLOSED period
 *     at post-time. This is validated in the application layer.
 *
 * FOR LLM MATH:
 *   To compute a trial balance for a period:
 *     1. Find the period by fundId + periodCode
 *     2. Query JournalLine where journal.fundId = X AND journal.periodId = period._id
 *     3. GROUP BY accountId, SUM(functionalDebit), SUM(functionalCredit)
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const accountingPeriodSchema = new Schema(
  {
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

    /**
     * Human-readable period code: "2026-01", "2026-Q1", "2026"
     * Convention: YYYY-MM for monthly, YYYY-QN for quarterly, YYYY for annual.
     */
    periodCode: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },

    periodType: {
      type: String,
      required: true,
      enum: ["MONTH", "QUARTER", "YEAR"],
    },

    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },

    /**
     * Period lifecycle:
     *   OPEN        → normal operations, all journal types allowed
     *   SOFT_CLOSED → only adjusting/closing entries (by accountant+ roles)
     *   HARD_CLOSED → no posting allowed, period is finalized
     *
     * Transition: OPEN → SOFT_CLOSED → HARD_CLOSED (one-way)
     * Reopening a HARD_CLOSED period requires ADMIN and creates an audit entry.
     */
    status: {
      type: String,
      required: true,
      enum: ["OPEN", "SOFT_CLOSED", "HARD_CLOSED"],
      default: "OPEN",
    },

    /** When was the period closed? */
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: "Identity" },

    /** When was NAV struck for this period? (fund accounting specific) */
    navStruckAt: { type: Date },
    navAmount:   { type: Schema.Types.Decimal128 },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "accountingperiods",

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

/** Unique period per fund */
accountingPeriodSchema.index({ fundId: 1, periodCode: 1 }, { unique: true });

/** Find open periods for a fund (for journal posting validation) */
accountingPeriodSchema.index({ fundId: 1, status: 1, startDate: 1 });

/** Find period by date range (which period does a transaction date fall in?) */
accountingPeriodSchema.index({ fundId: 1, startDate: 1, endDate: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(accountingPeriodSchema, {
  modelName: "AccountingPeriod",
  category: "ACCOUNTING",
  getLabel: (doc) => doc.periodCode,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("AccountingPeriod", accountingPeriodSchema);
