/**
 * ============================================================================
 * VCFO SCHEMA: JournalLine
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A single debit or credit line within a journal entry. This is THE atom
 *   of double-entry accounting — every financial report, every trial balance,
 *   every capital account statement is derived from JournalLines.
 *
 * THE THREE-AMOUNT PATTERN:
 *   Every line carries amounts in THREE currencies:
 *     1. Transaction currency — the actual currency the event happened in
 *     2. Functional currency  — the Fund's books currency (ASC 830)
 *     3. Reporting currency   — the Organization's consolidation currency
 *
 *   Example: A USD-functional fund invests EUR 1,000,000 at rate 1.08:
 *     transactionCurrency: "EUR"
 *     transactionDebit:    1000000.00  (or transactionCredit for the offset)
 *     functionalCurrency:  "USD"
 *     functionalDebit:     1080000.00
 *     reportingCurrency:   "USD"
 *     reportingDebit:      1080000.00
 *     fxRateTxnToFunctional: 1.08
 *
 * DEBIT/CREDIT CONVENTION:
 *   Each line has EITHER a debit OR a credit, never both.
 *   - transactionDebit > 0 AND transactionCredit = 0  → this is a DEBIT line
 *   - transactionCredit > 0 AND transactionDebit = 0  → this is a CREDIT line
 *   This is enforced in the application layer validation.
 *
 * DIMENSIONAL TAGGING:
 *   Lines carry optional dimensions: investorId, investmentId, costCenterId.
 *   These enable per-LP capital accounts, per-investment P&L, per-department
 *   reporting WITHOUT separate ledgers or sub-ledgers.
 *
 * FOR LLM MATH:
 *   Trial balance for a fund:
 *     db.journallines.aggregate([
 *       { $match: { fundId: X, "journal.status": "POSTED" } },
 *       { $group: {
 *           _id: "$accountId",
 *           totalDebit: { $sum: "$functionalDebit" },
 *           totalCredit: { $sum: "$functionalCredit" }
 *       }}
 *     ])
 *
 *   Account balance = totalDebit - totalCredit
 *   For DEBIT-normal accounts: positive = expected
 *   For CREDIT-normal accounts: negative = expected (flip for display)
 *
 *   LP capital account balance:
 *     Filter by investorId + accountClass: "EQUITY"
 *
 * MIGRATION SOURCE:
 *   Old: JournalLedger
 *   Key changes:
 *     - FX fields no longer suffixed with "1" (was: fXRateDrAmount1)
 *     - Debit/credit in THREE currencies, not one
 *     - Dimensional refs (investorId, investmentId) replace direct
 *       capitalCall/distribution refs
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const journalLineSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Parent references (denormalized for query speed)
    // ------------------------------------------------------------------

    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      required: true,
      index: true,
    },

    /** Denormalized from Journal — avoids joining for every query */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    /** Denormalized from Journal */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      required: true,
      index: true,
    },

    /** Denormalized from Journal */
    periodId: {
      type: Schema.Types.ObjectId,
      ref: "AccountingPeriod",
      required: true,
    },

    /** Line number within the journal (1, 2, 3...) for ordering */
    lineNumber: {
      type: Number,
      required: true,
      min: 1,
    },

    // ------------------------------------------------------------------
    // Account
    // ------------------------------------------------------------------

    accountId: {
      type: Schema.Types.ObjectId,
      ref: "ChartOfAccounts",
      required: [true, "Account is required on every journal line"],
      index: true,
    },

    /** Denormalized for fast reads and reporting */
    accountCode: { type: String },
    accountName: { type: String },

    // ------------------------------------------------------------------
    // THE THREE-AMOUNT PATTERN
    // Each line has amounts in three currencies.
    // Exactly ONE of (debit, credit) should be non-zero per currency.
    // All amounts are Decimal128 — NEVER use Number for money.
    // ------------------------------------------------------------------

    // --- Transaction currency (what actually happened) ---
    transactionCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    transactionDebit:  { type: Schema.Types.Decimal128, default: "0" },
    transactionCredit: { type: Schema.Types.Decimal128, default: "0" },

    // --- Functional currency (fund's books) ---
    functionalCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    functionalDebit:  { type: Schema.Types.Decimal128, default: "0" },
    functionalCredit: { type: Schema.Types.Decimal128, default: "0" },

    // --- Reporting currency (org's consolidation currency) ---
    reportingCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    reportingDebit:  { type: Schema.Types.Decimal128, default: "0" },
    reportingCredit: { type: Schema.Types.Decimal128, default: "0" },

    // --- FX rates used ---
    fxRateTxnToFunctional: { type: Schema.Types.Decimal128 },
    fxRateTxnToReporting:  { type: Schema.Types.Decimal128 },

    // ------------------------------------------------------------------
    // Dimensions — optional tags for multi-dimensional reporting
    // Whether required depends on the account (see ChartOfAccounts.requiresDimensions)
    // ------------------------------------------------------------------

    /** LP / Partner — for partner capital account tracking */
    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      default: null,
      index: true,
    },

    /** Portfolio company / asset — for investment-level P&L */
    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
      index: true,
    },

    /** Share class (for funds with multiple LP classes) */
    shareClassId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    /** Cost center / department for expense allocation */
    costCenterId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    /** For SPV-level tracking within a fund structure */
    spvId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
    },

    // ------------------------------------------------------------------
    // Investment lot tracking (for FIFO/LIFO cost basis)
    // ------------------------------------------------------------------

    lotId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    // ------------------------------------------------------------------
    // Tax dimensions
    // ------------------------------------------------------------------

    taxCode:         { type: String, trim: true },
    taxJurisdiction: { type: String, trim: true },
    is1099Reportable: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Line-level memo
    // ------------------------------------------------------------------

    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "journallines",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        // Convert all Decimal128 fields to strings for JSON
        const d128Fields = [
          "transactionDebit", "transactionCredit",
          "functionalDebit", "functionalCredit",
          "reportingDebit", "reportingCredit",
          "fxRateTxnToFunctional", "fxRateTxnToReporting",
        ];
        for (const f of d128Fields) {
          if (ret[f]) ret[f] = ret[f].toString();
        }
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// Optimized for the 7 most critical accounting queries.
// ---------------------------------------------------------------------------

/** Query 1: "All lines for a journal" — rebuilding a journal view */
journalLineSchema.index({ journalId: 1, lineNumber: 1 });

/** Query 2: "Trial balance" — all lines for a fund, grouped by account */
journalLineSchema.index({ fundId: 1, accountId: 1, periodId: 1 });

/** Query 3: "Account ledger" — all lines for a specific account over time */
journalLineSchema.index({ fundId: 1, accountId: 1 });

/** Query 4: "LP capital account" — all lines for a specific investor */
journalLineSchema.index({ fundId: 1, investorId: 1, accountId: 1 });

/** Query 5: "Investment P&L" — all lines for a specific investment */
journalLineSchema.index({ fundId: 1, investmentId: 1 });

/** Query 6: "Period detail" — all lines in a period (for period-close review) */
journalLineSchema.index({ fundId: 1, periodId: 1 });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

/**
 * Net amount in functional currency (positive = debit, negative = credit).
 * Useful for aggregation in application code.
 */
journalLineSchema.virtual("functionalNetAmount").get(function () {
  const debit = parseFloat(this.functionalDebit?.toString() || "0");
  const credit = parseFloat(this.functionalCredit?.toString() || "0");
  return debit - credit;
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(journalLineSchema, {
  modelName: "JournalLine",
  category: "ACCOUNTING",
  getLabel: (doc) => `Line ${doc.lineNumber}: ${doc.accountCode || doc.accountId}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("JournalLine", journalLineSchema);
