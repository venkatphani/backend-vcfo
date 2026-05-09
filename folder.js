/**
 * ============================================================================
 * VCFO SCHEMA: Folder
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A folder in the document management system. Supports hierarchical
 *   nesting via parentFolderId. Predefined system folders are identified
 *   by `folderType` enum instead of 20+ boolean flags.
 *
 * MENTAL MODEL:
 *   Organization ──► Fund ──► Folder tree
 *   Folder (1) ──► (N) Document (via Document.folderId)
 *   Folder (1) ──► (N) Folder (via parentFolderId — children)
 *
 * WHY REDESIGNED:
 *   The old Folder schema had 20+ boolean flags for predefined folders:
 *     isPortfolioPreDefined, isInvestorsPreDefined, isAccountingPreDefined,
 *     isCapitalCallsPreDefined, isDistributionPreDefined, isK1sPreDefined...
 *   Each new folder type required a schema migration. The new design uses
 *   a single `folderType` enum — adding a new predefined folder type is
 *   just adding a value to the enum.
 *
 * PREDEFINED FOLDERS:
 *   When a new fund is created, the system auto-generates predefined
 *   folders by creating Folder records with `isSystem: true` and the
 *   appropriate `folderType`. These cannot be deleted or renamed by users.
 *
 *   Default folder tree for a new fund:
 *   Fund I/
 *   ├── Portfolio/            (folderType: PORTFOLIO)
 *   │   └── [per company]     (folderType: PORTFOLIO_COMPANY, investmentId: ...)
 *   ├── Investors/            (folderType: INVESTORS)
 *   │   ├── Common/           (folderType: INVESTORS_COMMON)
 *   │   └── [per LP]          (folderType: INVESTOR_INDIVIDUAL, investorId: ...)
 *   ├── Accounting/           (folderType: ACCOUNTING)
 *   │   ├── Journals/         (folderType: JOURNALS)
 *   │   └── Bank Statements/  (folderType: BANK_STATEMENTS)
 *   ├── Capital Calls/        (folderType: CAPITAL_CALLS)
 *   ├── Distributions/        (folderType: DISTRIBUTIONS)
 *   ├── Tax/                  (folderType: TAX)
 *   │   ├── K-1s/             (folderType: K1S)
 *   │   └── 1065/             (folderType: TAX_1065)
 *   ├── Reports/              (folderType: REPORTS)
 *   │   └── Templates/        (folderType: REPORT_TEMPLATES)
 *   ├── Formation Docs/       (folderType: FORMATION)
 *   ├── Financials/           (folderType: FINANCIALS)
 *   ├── E-Sign/               (folderType: ESIGN)
 *   └── General/              (folderType: GENERAL)
 *
 * ACCOUNTING RELEVANCE:
 *   - Journal supporting docs go in JOURNALS folder (or linked via Document.journalId).
 *   - Capital call notices auto-filed to CAPITAL_CALLS folder.
 *   - LP-specific docs (sub agreements) go in INVESTOR_INDIVIDUAL folders.
 *   - Tax forms filed to TAX / K1S folders.
 *   - Audit reports filed to REPORTS folder.
 *
 * MIGRATION SOURCE:
 *   Old schema: Folder (with 20+ boolean flags)
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
 * Per-user access on a folder (inherited by documents inside).
 */
const folderPermissionSchema = new Schema(
  {
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
    },
    accessLevel: {
      type: String,
      required: true,
      enum: ["OWNER", "EDITOR", "VIEWER", "UPLOADER", "RESTRICTED"],
      default: "VIEWER",
    },
    grantedBy: { type: Schema.Types.ObjectId, ref: "Identity" },
    grantedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const folderSchema = new Schema(
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
    // Hierarchy
    // ------------------------------------------------------------------

    /**
     * Parent folder. Null = root-level folder for this fund/org.
     */
    parentFolderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Folder identity
    // ------------------------------------------------------------------

    folderName: {
      type: String,
      required: [true, "Folder name is required"],
      trim: true,
      maxlength: 200,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },

    // ------------------------------------------------------------------
    // Folder type (replaces 20+ boolean flags)
    // ------------------------------------------------------------------

    /**
     * What kind of folder is this?
     *
     * System-created predefined folders have `isSystem: true` and a
     * specific folderType. User-created folders use CUSTOM.
     *
     * MIGRATION from old booleans:
     *   isPortfolioPreDefined: true    → PORTFOLIO
     *   isInvestorsPreDefined: true    → INVESTORS
     *   isAccountingPreDefined: true   → ACCOUNTING
     *   isCapitalCallsPreDefined: true → CAPITAL_CALLS
     *   isDistributionPreDefined: true → DISTRIBUTIONS
     *   isReportsPreDefined: true      → REPORTS
     *   isFormationDocsPreDefined: true→ FORMATION
     *   isK1sPreDefined: true          → K1S
     *   isTaxesPreDefined: true        → TAX
     *   isFinancialsPreDefined: true   → FINANCIALS
     *   isCashPreDefined: true         → CASH
     *   isGeneralPreDefined: true      → GENERAL
     *   isESignProfilePreDefined: true → ESIGN
     *   isJournalsPreDefined: true     → JOURNALS
     *   isAuditReportsPredefined: true → AUDIT_REPORTS
     *   is1065ReportsPredefined: true  → TAX_1065
     *   isReportTemplatesPredefined    → REPORT_TEMPLATES
     *   isLineofCreditPreDefined: true → LINE_OF_CREDIT
     *   isIncomeAndExpensesPreDefined  → INCOME_EXPENSES
     */
    folderType: {
      type: String,
      required: true,
      enum: [
        // Top-level predefined
        "PORTFOLIO",
        "INVESTORS",
        "ACCOUNTING",
        "CAPITAL_CALLS",
        "DISTRIBUTIONS",
        "TAX",
        "REPORTS",
        "FORMATION",
        "FINANCIALS",
        "CASH",
        "GENERAL",
        "ESIGN",

        // Second-level predefined
        "PORTFOLIO_COMPANY",     // Per-company subfolder under PORTFOLIO
        "INVESTORS_COMMON",      // Shared docs for all investors
        "INVESTOR_INDIVIDUAL",   // Per-LP subfolder under INVESTORS
        "JOURNALS",              // Under ACCOUNTING
        "BANK_STATEMENTS",       // Under ACCOUNTING
        "K1S",                   // Under TAX
        "TAX_1065",              // Under TAX
        "REPORT_TEMPLATES",      // Under REPORTS
        "AUDIT_REPORTS",         // Under REPORTS
        "LINE_OF_CREDIT",        // Under FINANCIALS
        "INCOME_EXPENSES",       // Under FINANCIALS

        // User-created
        "CUSTOM",
      ],
      default: "CUSTOM",
    },

    /**
     * Is this a system-created predefined folder?
     * System folders cannot be deleted or renamed by users.
     */
    isSystem: {
      type: Boolean,
      default: false,
    },

    // ------------------------------------------------------------------
    // Entity linkage (for per-entity subfolders)
    // ------------------------------------------------------------------

    /** For INVESTOR_INDIVIDUAL folders — which investor */
    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      default: null,
    },

    /** For PORTFOLIO_COMPANY folders — which investment */
    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
    },

    /** For journal-linked folders */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** For capital call-linked folders */
    capitalCallId: {
      type: Schema.Types.ObjectId,
      ref: "CapitalCall",
      default: null,
    },

    /** For distribution-linked folders */
    distributionId: {
      type: Schema.Types.ObjectId,
      ref: "Distribution",
      default: null,
    },

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    permissions: [folderPermissionSchema],

    /**
     * Visibility — same as Document.
     * Folder visibility is inherited by documents inside unless overridden.
     */
    visibility: {
      type: String,
      enum: ["FUND_TEAM", "INVESTORS", "SPECIFIC", "PUBLIC"],
      default: "FUND_TEAM",
    },

    /**
     * Is this a "common" folder shared across all investors?
     * (e.g., quarterly reports that all LPs should see)
     */
    isCommon: {
      type: Boolean,
      default: false,
    },

    // ------------------------------------------------------------------
    // User interaction
    // ------------------------------------------------------------------

    isFavorite: {
      type: Boolean,
      default: false,
    },

    lastAccessedAt: {
      type: Date,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: "Identity" },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "folders",

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

/** Folder tree: children of a parent */
folderSchema.index({ parentFolderId: 1, isDeleted: 1 });

/** All folders for a fund */
folderSchema.index({ fundId: 1, isDeleted: 1, folderType: 1 });

/** Find predefined folders (for auto-filing) */
folderSchema.index({ fundId: 1, folderType: 1, isSystem: 1 });

/** Investor-specific folders */
folderSchema.index({ fundId: 1, investorId: 1 }, { sparse: true });

/** Investment-specific folders */
folderSchema.index({ fundId: 1, investmentId: 1 }, { sparse: true });

/** Favorites and recent */
folderSchema.index({ fundId: 1, isFavorite: 1, isDeleted: 1 });
folderSchema.index({ fundId: 1, lastAccessedAt: -1, isDeleted: 1 });

/** Org-wide folder listing */
folderSchema.index({ organizationId: 1, isDeleted: 1 });

/** Journal/CapCall/Distribution linked folders */
folderSchema.index({ journalId: 1 }, { sparse: true });
folderSchema.index({ capitalCallId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

folderSchema.virtual("isRoot").get(function () {
  return this.parentFolderId == null;
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(folderSchema, {
  modelName: "Folder",
  category: "DOCUMENT",
  getLabel: (doc) => doc.folderName,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Folder", folderSchema);
