/**
 * ============================================================================
 * VCFO SCHEMA: FxRate
 * ============================================================================
 *
 * WHAT THIS IS:
 *   Exchange rate library. Stores rates for currency conversion in journals.
 *   Multiple rate types are needed because ASC 830 requires different rates
 *   for different items:
 *     SPOT:       Current market rate (for transaction-date entries)
 *     PERIOD_END: Rate at period close (for monetary B/S items)
 *     PERIOD_AVG: Average rate over period (for P&L items)
 *     HISTORICAL: Rate at the date of original transaction (for equity items)
 *
 * FOR LLM MATH:
 *   To convert EUR 1,000 to USD at spot rate:
 *     1. Find FxRate { fromCurrency: "EUR", toCurrency: "USD", rateDate: date, rateType: "SPOT" }
 *     2. USD amount = EUR amount × rate
 *   Note: rates are stored as "1 FROM = X TO", e.g., rate 1.08 means 1 EUR = 1.08 USD.
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const fxRateSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    /** Source currency (ISO 4217) */
    fromCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },

    /** Target currency (ISO 4217) */
    toCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },

    /** The date this rate applies to */
    rateDate: {
      type: Date,
      required: true,
    },

    /** What kind of rate this is (determines when to use it) */
    rateType: {
      type: String,
      required: true,
      enum: ["SPOT", "PERIOD_END", "PERIOD_AVG", "HISTORICAL"],
    },

    /**
     * The exchange rate: 1 fromCurrency = rate × toCurrency
     * Example: fromCurrency=EUR, toCurrency=USD, rate=1.08
     *          means 1 EUR = 1.08 USD
     */
    rate: {
      type: Schema.Types.Decimal128,
      required: [true, "Rate is required"],
    },

    /** Where did this rate come from? */
    source: {
      type: String,
      enum: ["MANUAL", "BLOOMBERG", "ECB", "OANDA", "OPEN_EXCHANGE", "INTERNAL"],
      default: "MANUAL",
    },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "fxrates",

    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        // Convert Decimal128 to string for JSON
        if (ret.rate) ret.rate = ret.rate.toString();
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Primary lookup: find rate for a specific conversion on a specific date */
fxRateSchema.index(
  { organizationId: 1, fromCurrency: 1, toCurrency: 1, rateDate: 1, rateType: 1 },
  { unique: true }
);

/** Find all rates for a date (for period-end revaluation) */
fxRateSchema.index({ organizationId: 1, rateDate: 1, rateType: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(fxRateSchema, {
  modelName: "FxRate",
  category: "ACCOUNTING",
  getLabel: (doc) => `${doc.fromCurrency}/${doc.toCurrency} ${doc.rateType}`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: () => null,
});

module.exports = model("FxRate", fxRateSchema);
