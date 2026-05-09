/**
 * ============================================================================
 * VCFO SCHEMA: BankTransaction
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A bank transaction from a connected bank account (Plaid, Mercury, or
 *   manual CSV upload). This is the RAW bank data that needs to be
 *   reconciled (matched) to journal entries in the fund's GL.
 *
 * MENTAL MODEL:
 *   BankConnection (1) ──► (N) BankTransaction
 *   BankTransaction (0..1) ──► Journal (once reconciled)
 *
 *   Unreconciled transactions = bank statement items not yet matched to GL.
 *   Reconciled transactions = matched to a journal entry.
 *
 * THE RECONCILIATION FLOW:
 *   1. Bank transactions sync from provider (or uploaded via CSV)
 *   2. AI suggests journal entries (preFillData) based on description/amount
 *   3. Accountant reviews, assigns to a fund, picks GL accounts
 *   4. On reconcile: journal is created, BankTransaction links to it
 *   5. At period-end: bank balance should match GL cash balance
 *
 * WHY UNIFIED (NOT SEPARATE PLAID + MERCURY):
 *   From accounting's perspective, a $5,000 deposit is a $5,000 deposit
 *   whether it came from Plaid or Mercury. The `provider` field on
 *   BankConnection tells us the source. This schema stores the normalized
 *   transaction data.
 *
 * ACCOUNTING RELEVANCE:
 *   - Unreconciled bank transactions are the "bank side" of bank reconciliation.
 *   - The "book side" is the GL cash account balance from JournalLines.
 *   - Reconciling items = timing differences between bank and books.
 *   - At period-end:
 *       Bank balance (from transactions) - Outstanding deposits - Outstanding checks
 *       = GL cash balance (from journal lines)
 *
 * FOR LLM MATH:
 *   Bank balance from transactions:
 *     SUM(all BankTransaction.amount WHERE bankConnectionId = X)
 *     (positive = inflow, negative = outflow)
 *
 *   Unreconciled items:
 *     BankTransaction.find({ bankConnectionId, status: { $in: ["NOT_STARTED", "IN_PROGRESS"] } })
 *
 *   Reconciliation completion rate:
 *     COUNT(status = "COMPLETE") / COUNT(all) × 100
 *
 * MIGRATION SOURCE:
 *   Old schemas: BankFeedActivity + PlaidBankFeed + MercuryTransaction
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const bankTransactionSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope — FIRM LEVEL with optional fund assignment
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    /** Which bank account this transaction belongs to */
    bankConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "BankConnection",
      required: true,
      index: true,
    },

    /**
     * Which fund this transaction is reconciled to.
     * Null until assigned during reconciliation.
     * Defaults to BankConnection.defaultFundId if set.
     */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Transaction data (normalized from any provider)
    // ------------------------------------------------------------------

    /** Transaction date (when it posted at the bank) */
    transactionDate: {
      type: Date,
      required: true,
    },

    /**
     * Amount in the bank account's currency.
     * Positive = inflow (deposit, credit).
     * Negative = outflow (withdrawal, debit, payment).
     */
    amount: {
      type: Schema.Types.Decimal128,
      required: true,
    },

    currency: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 3,
      default: "USD",
    },

    /**
     * Running balance after this transaction (if available from provider).
     */
    balance: { type: Schema.Types.Decimal128 },

    /** Bank's description / memo */
    description: { type: String, trim: true, maxlength: 1000 },

    /** Shortened / cleaned description for display */
    descriptionShort: { type: String, trim: true, maxlength: 200 },

    /** Counterparty / merchant name */
    counterpartyName: { type: String, trim: true },

    /** Check number (if applicable) */
    checkNumber: { type: String, trim: true },

    /** Payment method / channel */
    paymentChannel: {
      type: String,
      enum: ["ACH", "WIRE", "CHECK", "CARD", "INTERNAL_TRANSFER", "FEE", "INTEREST", "OTHER"],
    },

    /** Bank's category / classification */
    bankCategory: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Provider reference (for deduplication and tracing)
    // ------------------------------------------------------------------

    /** Provider's unique transaction ID (Plaid transaction_id, Mercury transactionId) */
    providerTransactionId: {
      type: String,
      trim: true,
    },

    /** External reference ID */
    externalReference: { type: String, trim: true },

    /** Is this transaction still pending at the bank? */
    isPending: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Reconciliation
    // ------------------------------------------------------------------

    /**
     * Reconciliation status:
     *   NOT_STARTED: new transaction, not yet reviewed
     *   IN_PROGRESS: being worked on (AI suggested, accountant reviewing)
     *   COMPLETE: matched to a journal entry
     *   DUPLICATE: duplicate transaction, skipped
     *   EXCLUDED: intentionally excluded from reconciliation
     *   FAILED: auto-reconciliation failed, needs manual review
     */
    status: {
      type: String,
      enum: ["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "DUPLICATE", "EXCLUDED", "FAILED"],
      default: "NOT_STARTED",
    },

    /** The journal entry this transaction was reconciled to */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** Who reconciled it */
    reconciledBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    /** When it was reconciled */
    reconciledAt: { type: Date },

    /**
     * GL account type suggestion (from rules or AI).
     * Stored so the accountant sees a pre-filled suggestion.
     */
    suggestedAccountType: { type: String, trim: true },

    // ------------------------------------------------------------------
    // AI / automation
    // ------------------------------------------------------------------

    /** Was this uploaded via AI document parsing? */
    isAiProcessed: { type: Boolean, default: false },

    /** AI-suggested journal entry data (pre-fill for accountant) */
    aiSuggestion: {
      type: Schema.Types.Mixed,
    },

    /** AI confidence score (0-1) */
    aiConfidence: { type: Number, min: 0, max: 1 },

    /** Was this created from a manual CSV upload? */
    isManualUpload: { type: Boolean, default: false },

    /** Reference to the uploaded file */
    sourceFileId: { type: Schema.Types.ObjectId },

    // ------------------------------------------------------------------
    // Source document linkage
    // ------------------------------------------------------------------

    /** Link to firm-level Activity/WorkItem if created from document */
    activityId: {
      type: Schema.Types.ObjectId,
      ref: "Activity",
      default: null,
    },

    // ------------------------------------------------------------------
    // Raw data
    // ------------------------------------------------------------------

    /** Full provider response for traceability */
    rawData: { type: Schema.Types.Mixed, select: false },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    tags: [{ type: String, trim: true, lowercase: true }],

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "banktransactions",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        delete ret.rawData;
        const d128 = ["amount", "balance"];
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

/** Primary query: all transactions for a bank account by date */
bankTransactionSchema.index({ bankConnectionId: 1, transactionDate: -1 });

/** Reconciliation queue: unreconciled transactions for an org */
bankTransactionSchema.index({ organizationId: 1, status: 1, transactionDate: -1 });

/** Deduplication: prevent importing the same transaction twice */
bankTransactionSchema.index(
  { bankConnectionId: 1, providerTransactionId: 1 },
  { unique: true, sparse: true }
);

/** Fund-specific transaction view */
bankTransactionSchema.index({ fundId: 1, transactionDate: -1 });

/** Journal linkage */
bankTransactionSchema.index({ journalId: 1 }, { sparse: true });

/** Source file lookup (find all transactions from a CSV upload) */
bankTransactionSchema.index({ sourceFileId: 1 }, { sparse: true });

/** Activity linkage */
bankTransactionSchema.index({ activityId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

bankTransactionSchema.virtual("isInflow").get(function () {
  return parseFloat(this.amount?.toString() || "0") > 0;
});

bankTransactionSchema.virtual("isReconciled").get(function () {
  return this.status === "COMPLETE" && this.journalId != null;
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(bankTransactionSchema, {
  modelName: "BankTransaction",
  category: "BANKING",
  getLabel: (doc) => `${doc.transactionDate?.toISOString?.()?.slice(0, 10) || ""} ${doc.amount} ${doc.descriptionShort || ""}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("BankTransaction", bankTransactionSchema);
