/**
 * ============================================================================
 * VCFO SCHEMA: InvestmentRight
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A legal right or provision extracted from investment documents.
 *   When the fund invests in a company, various documents grant specific
 *   rights (pro-rata, board seat, information rights, drag-along, etc.).
 *   This schema tracks those rights per investment for quick reference
 *   without reading the full legal docs.
 *
 * MENTAL MODEL:
 *   Investment (1) ──► (N) InvestmentRight
 *   InvestmentRight (0..1) ──► Document (source legal document)
 *
 * WHY THIS EXISTS:
 *   GPs need to quickly answer: "Do we have pro-rata rights in Acme Corp?"
 *   "What board provisions does our SPA grant?" Without this, you'd have
 *   to dig through legal docs. The AI agent parses documents and extracts
 *   rights into structured records.
 *
 * ACCOUNTING RELEVANCE:
 *   - Information rights affect reporting obligations.
 *   - Pro-rata rights affect follow-on investment decisions.
 *   - Board seats may create management fee offset obligations.
 *   - Drag-along/tag-along affect exit scenarios.
 *
 * MIGRATION SOURCE:
 *   Old schema: FavoriteRights
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const investmentRightSchema = new Schema(
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

    /** Which investment / portfolio company this right relates to */
    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      required: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Right identity
    // ------------------------------------------------------------------

    /**
     * Source document type that grants this right.
     */
    sourceDocType: {
      type: String,
      required: true,
      enum: [
        "IRA",                   // Investors' Rights Agreement
        "SPA",                   // Stock Purchase Agreement
        "COI",                   // Certificate of Incorporation
        "VOTING_AGREEMENT",      // Voting Agreement
        "CO_SALE_AGREEMENT",     // Co-Sale / Tag-Along Agreement
        "MANAGEMENT_RIGHTS",     // Management Rights Letter
        "CAP_TABLE",             // Cap Table
        "TERM_SHEET",            // Term Sheet
        "BYLAWS",                // Corporate Bylaws
        "SIDE_LETTER",           // Side Letter
        "LPA",                   // Limited Partnership Agreement
        "OTHER",
      ],
    },

    /** Source document reference */
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },

    /**
     * Unique key for this right within the document type.
     * E.g., "pro_rata", "board_seat", "information_rights"
     */
    rightKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    /** Human-readable name of the right */
    rightName: {
      type: String,
      required: true,
      trim: true,
    },

    /** Description of what this right entails */
    description: {
      type: String,
      maxlength: 5000,
    },

    // ------------------------------------------------------------------
    // Classification
    // ------------------------------------------------------------------

    /**
     * Category of the right.
     */
    category: {
      type: String,
      enum: [
        "ECONOMIC",            // Pro-rata, dividends, liquidation preference
        "GOVERNANCE",          // Board seat, voting, consent rights
        "PROTECTIVE",          // Anti-dilution, drag-along, tag-along
        "INFORMATION",         // Financial reporting, inspection rights
        "TRANSFER",            // ROFR, co-sale, transfer restrictions
        "OPERATIONAL",         // Management rights, MRL
        "OTHER",
      ],
    },

    /** Is this right currently active? */
    isActive: {
      type: Boolean,
      default: true,
    },

    /** When does this right expire (if applicable)? */
    expiresAt: { type: Date },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "investmentrights",

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

/** Unique right per investment per document type per key */
investmentRightSchema.index(
  { investmentId: 1, sourceDocType: 1, rightKey: 1 },
  { unique: true }
);

/** All rights for an investment */
investmentRightSchema.index({ investmentId: 1, isActive: 1 });

/** Org-wide rights by type */
investmentRightSchema.index({ organizationId: 1, sourceDocType: 1 });

/** Document linkage */
investmentRightSchema.index({ documentId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(investmentRightSchema, {
  modelName: "InvestmentRight",
  category: "INVESTMENT",
  getLabel: (doc) => doc.rightName,
  getOrgId: (doc) => doc.organizationId,
  getFundId: () => null,
});

module.exports = model("InvestmentRight", investmentRightSchema);
