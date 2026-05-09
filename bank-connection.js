/**
 * ============================================================================
 * VCFO SCHEMA: BankConnection
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A connected bank account — via Plaid, Mercury, or manual CSV upload.
 *   Lives at the ORGANIZATION level (firm-level), not per-fund.
 *   Transactions from this account get reconciled to specific funds.
 *
 * WHY UNIFIED (NOT SEPARATE PLAID + MERCURY):
 *   The old system had PlaidAccount and MercuryAccount as separate schemas.
 *   From the accounting perspective, a bank account is a bank account
 *   regardless of how it's connected. The `provider` field distinguishes
 *   the connection method while keeping the data model clean.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) BankConnection
 *   BankConnection (1) ──► (N) BankTransaction (incoming feed)
 *   BankTransaction ──► (0..1) Journal (once reconciled)
 *
 * ACCOUNTING RELEVANCE:
 *   - Each BankConnection maps to a GL cash account in one or more funds.
 *   - Bank transactions become the source of truth for cash movements.
 *   - Reconciliation = matching a BankTransaction to a Journal entry.
 *   - Bank balance should match the GL cash account balance at period-end.
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const bankConnectionSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope — FIRM LEVEL
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    /**
     * Default fund for transactions from this account.
     * Can be overridden per transaction during reconciliation.
     * Null if this is a firm operating account used across funds.
     */
    defaultFundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
    },

    // ------------------------------------------------------------------
    // Provider
    // ------------------------------------------------------------------

    /**
     * How this bank account is connected.
     */
    provider: {
      type: String,
      required: true,
      enum: ["PLAID", "MERCURY", "MANUAL", "OTHER"],
    },

    // ------------------------------------------------------------------
    // Bank identity
    // ------------------------------------------------------------------

    bankName:      { type: String, trim: true },
    accountName:   { type: String, trim: true },
    accountType:   { type: String, enum: ["CHECKING", "SAVINGS", "MONEY_MARKET", "CREDIT_CARD", "INVESTMENT", "OTHER"] },
    currency:      { type: String, uppercase: true, trim: true, maxlength: 3, default: "USD" },

    /** Display-safe masked account number (last 4 only) */
    accountNumberMask: { type: String, trim: true },

    /** Region / country of bank */
    region: { type: String, trim: true },

    // ------------------------------------------------------------------
    // Banking details (for wire/ACH)
    // ------------------------------------------------------------------

    routing: {
      /** US ACH routing number */
      achRouting:         { type: String, trim: true },
      /** US wire routing number */
      wireRouting:        { type: String, trim: true },
      /** UK sort code */
      sortCode:           { type: String, trim: true },
      /** Canada transit/branch number */
      branchNumber:       { type: String, trim: true },
      /** Canada institution number */
      institutionNumber:  { type: String, trim: true },
      /** EU/International IBAN */
      iban:               { type: String, trim: true },
      /** SWIFT/BIC code */
      swiftBic:           { type: String, trim: true },
    },

    // ------------------------------------------------------------------
    // Provider-specific credentials (SENSITIVE — always redacted)
    // ------------------------------------------------------------------

    providerCredentials: {
      /** Plaid */
      plaidAccessToken:  { type: String, select: false },
      plaidItemId:       { type: String, select: false },
      plaidAccountId:    { type: String },

      /** Mercury */
      mercuryAccountId:    { type: String },
      mercuryAccessToken:  { type: String, select: false },
      mercuryRefreshToken: { type: String, select: false },
      mercuryTokenExpiresAt: { type: Date },
      mercuryClientId:     { type: String, select: false },
      mercuryClientSecret: { type: String, select: false },
      isProduction:        { type: Boolean },
    },

    // ------------------------------------------------------------------
    // Balances (synced from provider)
    // ------------------------------------------------------------------

    currentBalance:   { type: Schema.Types.Decimal128 },
    availableBalance: { type: Schema.Types.Decimal128 },
    balanceAsOf:      { type: Date },

    // ------------------------------------------------------------------
    // Sync status
    // ------------------------------------------------------------------

    lastSyncedAt: { type: Date },
    lastSyncStatus: {
      type: String,
      enum: ["SUCCESS", "PARTIAL", "FAILED", "NEVER_SYNCED"],
      default: "NEVER_SYNCED",
    },
    lastSyncError: { type: String },

    /** Does the connection need re-authentication? */
    needsReconnection: { type: Boolean, default: false },
    reconnectionReason: { type: String },

    // ------------------------------------------------------------------
    // GL mapping
    // ------------------------------------------------------------------

    /**
     * Which ChartOfAccounts cash account this bank maps to.
     * Used during reconciliation to auto-suggest the correct GL account.
     */
    glAccountId: {
      type: Schema.Types.ObjectId,
      ref: "ChartOfAccounts",
      default: null,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE", "DISCONNECTED", "ARCHIVED"],
      default: "ACTIVE",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    /** Raw provider data for debugging */
    rawProviderData: { type: Schema.Types.Mixed, select: false },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "bankconnections",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        // Always strip credentials from output
        delete ret.providerCredentials;
        delete ret.rawProviderData;
        const d128 = ["currentBalance", "availableBalance"];
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

/** All connections for an org */
bankConnectionSchema.index({ organizationId: 1, status: 1 });

/** Find by provider account ID (dedup on sync) */
bankConnectionSchema.index(
  { organizationId: 1, "providerCredentials.plaidAccountId": 1 },
  { sparse: true }
);
bankConnectionSchema.index(
  { organizationId: 1, "providerCredentials.mercuryAccountId": 1 },
  { sparse: true }
);

/** Default fund mapping */
bankConnectionSchema.index({ defaultFundId: 1 }, { sparse: true });

/** Accounts needing reconnection */
bankConnectionSchema.index({ needsReconnection: 1, status: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(bankConnectionSchema, {
  modelName: "BankConnection",
  category: "BANKING",
  getLabel: (doc) => `${doc.bankName || "Bank"} - ${doc.accountName || doc.accountNumberMask || ""}`,
  redactFields: [
    "providerCredentials.plaidAccessToken",
    "providerCredentials.plaidItemId",
    "providerCredentials.mercuryAccessToken",
    "providerCredentials.mercuryRefreshToken",
    "providerCredentials.mercuryClientId",
    "providerCredentials.mercuryClientSecret",
    "routing.achRouting",
    "routing.wireRouting",
    "routing.iban",
  ],
  getOrgId: (doc) => doc.organizationId,
  getFundId: () => null,
});

module.exports = model("BankConnection", bankConnectionSchema);
