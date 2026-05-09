/**
 * ============================================================================
 * VCFO SCHEMA: ChartOfAccounts
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A GL (General Ledger) account within a Fund's chart of accounts.
 *   Every journal line debits or credits one of these accounts.
 *
 * WHY THIS IS DYNAMIC (NOT HARDCODED):
 *   The old AccountMapping had a hardcoded enum of account types:
 *     "Cash", "Receivable", "Expense", "Investment", "Investment - Unrealized Gain/Loss"...
 *   This is fragile — adding a new type requires a code deploy.
 *
 *   The new design uses a TWO-LEVEL classification system:
 *     accountClass:   ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE (the 5 pillars)
 *     accountSubClass: Dynamic string — "CASH", "RECEIVABLE", "INVESTMENT_FV",
 *                      "UNREALIZED_GAIN_LOSS", etc. Not an enum. New sub-classes
 *                      can be created without schema changes.
 *
 *   Plus a HIERARCHY via parentAccountId for roll-up reporting:
 *     1000 Assets
 *       1100 Cash & Equivalents
 *         1110 Operating Cash
 *         1120 Restricted Cash
 *       1200 Investments at Fair Value
 *         1210 Equity Securities
 *         1220 Convertible Notes
 *       1300 Receivables
 *
 * ACCOUNTING RELEVANCE:
 *   - `normalBalance` determines sign convention. Assets/Expenses are DEBIT-normal.
 *     Liabilities/Equity/Revenue are CREDIT-normal. A debit INCREASES a debit-normal
 *     account and DECREASES a credit-normal account.
 *   - `accountClass` determines financial statement placement (BS vs P&L).
 *   - `requiresDimensions` enforces that journal lines hitting this account MUST
 *     carry specific tags (e.g., investment account requires investmentId).
 *   - `isControlAccount` prevents direct manual posting — only system-generated
 *     entries (from capital calls, distributions, etc.) can hit these accounts.
 *
 * FOR LLM MATH:
 *   Trial Balance = SUM(debits) - SUM(credits) per account, in functional currency.
 *   For DEBIT-normal accounts: positive balance = debit balance (normal).
 *   For CREDIT-normal accounts: positive balance = credit balance (normal).
 *   Balance Sheet: ASSET accounts + LIABILITY accounts + EQUITY accounts.
 *   Income Statement: REVENUE accounts + EXPENSE accounts.
 *   NET INCOME = SUM(REVENUE) - SUM(EXPENSE) (in functional currency).
 *
 * MIGRATION SOURCE:
 *   Old schema: AccountMapping
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const chartOfAccountsSchema = new Schema(
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
    // Account identity
    // ------------------------------------------------------------------

    /**
     * Numeric account code following standard accounting convention:
     *   1000-1999: Assets
     *   2000-2999: Liabilities
     *   3000-3999: Equity / Partner Capital
     *   4000-4999: Revenue / Income
     *   5000-5999: Expenses
     *   6000-6999: Gains & Losses
     *   7000-7999: Other / Memo
     *
     * Codes are strings (not numbers) to support sub-codes like "1100.10"
     */
    accountCode: {
      type: String,
      required: [true, "Account code is required"],
      trim: true,
      maxlength: 20,
    },

    /** Human-readable name: "Operating Cash Account" */
    accountName: {
      type: String,
      required: [true, "Account name is required"],
      trim: true,
      maxlength: 200,
    },

    /** Optional description for clarity */
    description: { type: String, trim: true, maxlength: 1000 },

    // ------------------------------------------------------------------
    // Classification (THE KEY DESIGN)
    // ------------------------------------------------------------------

    /**
     * The 5 fundamental account classes.
     * This is an enum — it will NEVER change (these are the pillars of
     * double-entry bookkeeping since Luca Pacioli, 1494).
     */
    accountClass: {
      type: String,
      required: true,
      enum: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"],
    },

    /**
     * Sub-classification — NOT an enum. This is a free string that allows
     * dynamic categorization without schema changes.
     *
     * Common values (convention, not enforced):
     *   ASSET:     CASH, RESTRICTED_CASH, INVESTMENT_AT_FV, INVESTMENT_AT_COST,
     *              RECEIVABLE, PREPAID, DUE_FROM_RELATED, OTHER_ASSET
     *   LIABILITY: PAYABLE, ACCRUED_EXPENSE, DUE_TO_RELATED, CREDIT_FACILITY,
     *              ESCROW, OTHER_LIABILITY
     *   EQUITY:    PARTNER_CAPITAL_CONTRIBUTION, PARTNER_CAPITAL_DISTRIBUTION,
     *              RETAINED_EARNINGS, ACCUMULATED_OCI, CARRIED_INTEREST_ALLOC
     *   REVENUE:   INTEREST_INCOME, DIVIDEND_INCOME, REALIZED_GAIN,
     *              UNREALIZED_GAIN, MGMT_FEE_INCOME, OTHER_INCOME
     *   EXPENSE:   MGMT_FEE_EXPENSE, ADMIN_EXPENSE, LEGAL_EXPENSE,
     *              AUDIT_EXPENSE, REALIZED_LOSS, UNREALIZED_LOSS,
     *              FX_LOSS, ORGANIZATIONAL_EXPENSE, OTHER_EXPENSE
     *
     * The application layer can maintain a registry of known sub-classes
     * for UI dropdowns, but the schema accepts any string.
     */
    accountSubClass: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 100,
    },

    /**
     * Normal balance direction.
     * DEBIT-normal:  Assets, Expenses (increase with debits)
     * CREDIT-normal: Liabilities, Equity, Revenue (increase with credits)
     *
     * ACCOUNTING RULE for LLM:
     *   balance = SUM(debits) - SUM(credits) in functional currency
     *   For DEBIT-normal:  positive balance means the account has a debit balance (normal)
     *   For CREDIT-normal: negative balance (in the above formula) means credit balance (normal)
     *   OR equivalently: flip the sign for credit-normal accounts in reports.
     */
    normalBalance: {
      type: String,
      required: true,
      enum: ["DEBIT", "CREDIT"],
    },

    // ------------------------------------------------------------------
    // Hierarchy
    // ------------------------------------------------------------------

    /** Parent account for roll-up reporting. Null = top-level account. */
    parentAccountId: {
      type: Schema.Types.ObjectId,
      ref: "ChartOfAccounts",
      default: null,
    },

    /** Depth in hierarchy: 0 = root, 1 = child, 2 = grandchild, etc. */
    depth: { type: Number, default: 0, min: 0 },

    /** Sort order within the same parent for report ordering */
    sortOrder: { type: Number, default: 0 },

    // ------------------------------------------------------------------
    // Dimensional requirements
    // When true, journal lines hitting this account MUST carry the dimension.
    // ------------------------------------------------------------------

    requiresInvestor:    { type: Boolean, default: false },
    requiresInvestment:  { type: Boolean, default: false },
    requiresCostCenter:  { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Control flags
    // ------------------------------------------------------------------

    /**
     * If true, only system-generated journals (capital calls, distributions,
     * fee calculations) can post to this account. Manual journal entries
     * are rejected. Used for partner capital accounts, carried interest, etc.
     */
    isControlAccount: { type: Boolean, default: false },

    /** Can journal lines be posted to this account? */
    isPostable: { type: Boolean, default: true },

    /** Is this account currently active? Inactive accounts reject new postings. */
    isActive: { type: Boolean, default: true },

    /**
     * Is this a system-default account that ships with the CoA template?
     * Default accounts cannot be deleted (only deactivated).
     */
    isDefault: { type: Boolean, default: false },

    /** Restrict which currencies can be used on lines hitting this account */
    allowedCurrencies: {
      type: [String],
      default: undefined, // undefined = allow all
    },

    // ------------------------------------------------------------------
    // Display
    // ------------------------------------------------------------------

    /** Optional label override for reports (e.g., "Cash" instead of "Operating Cash Account - Primary") */
    reportLabel: { type: String, trim: true, maxlength: 100 },

    /** Whether to show this account on financial statements even with zero balance */
    showWhenZero: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "chartofaccounts",

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

/** Unique account code per fund */
chartOfAccountsSchema.index({ fundId: 1, accountCode: 1 }, { unique: true });

/** Unique account name per fund */
chartOfAccountsSchema.index({ fundId: 1, accountName: 1 }, { unique: true });

/** List all accounts for a fund by class (for financial statements) */
chartOfAccountsSchema.index({ fundId: 1, accountClass: 1, sortOrder: 1 });

/** Hierarchy traversal */
chartOfAccountsSchema.index({ parentAccountId: 1 });

/** Find active/postable accounts */
chartOfAccountsSchema.index({ fundId: 1, isActive: 1, isPostable: 1 });

// ---------------------------------------------------------------------------
// Pre-save: auto-set normalBalance from accountClass if not provided
// ---------------------------------------------------------------------------

chartOfAccountsSchema.pre("validate", function (next) {
  if (!this.normalBalance && this.accountClass) {
    const debitNormal = ["ASSET", "EXPENSE"];
    this.normalBalance = debitNormal.includes(this.accountClass) ? "DEBIT" : "CREDIT";
  }
  next();
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(chartOfAccountsSchema, {
  modelName: "ChartOfAccounts",
  category: "ACCOUNTING",
  getLabel: (doc) => `${doc.accountCode} - ${doc.accountName}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("ChartOfAccounts", chartOfAccountsSchema);
