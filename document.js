/**
 * ============================================================================
 * VCFO SCHEMA: Document
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A file or document stored in the system. Replaces the old File,
 *   DocumentRoom, and JournalDocument schemas with a single unified
 *   collection. Every uploaded file — invoices, bank statements, SPAs,
 *   tax forms, call notices, signed docs — lives here.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) Document
 *   Document (0..1) ──► Folder (via folderId)
 *   Document (0..1) ──► Fund, Investor, Investment, Journal, CapitalCall, etc.
 *   Document (1) ──► (N) DocumentAccessLog
 *
 *   A Document is the FILE itself plus metadata about what it is,
 *   who can see it, and where it belongs. The actual file bytes live
 *   in cloud storage (S3/GCS); this record stores the URL/key.
 *
 * WHY UNIFIED (NOT SEPARATE FILE + DOCUMENTROOM):
 *   Old system had File (raw uploads at entity level) and DocumentRoom
 *   (classified documents with 15+ boolean flags). The distinction was
 *   artificial — a file becomes a document when classified. In the new
 *   design, every upload is a Document from the start. Classification
 *   happens via the `category` enum, not boolean flags.
 *
 * OLD BOOLEAN FLAGS → NEW ENUM:
 *   isCapitalCall: true     → category: "CAPITAL_CALL"
 *   isDistribution: true    → category: "DISTRIBUTION"
 *   isPartner: true         → category: "INVESTOR"
 *   isAccounting: true      → category: "ACCOUNTING"
 *   isInvestment: true      → category: "INVESTMENT"
 *   isInvoice: true         → category: "INVOICE"
 *   isSignedDocument: true  → category: "SIGNED"
 *   isOnboarding: true      → category: "ONBOARDING"
 *   isFinancingDocument     → category: "FINANCING"
 *
 * ACCOUNTING RELEVANCE:
 *   - Invoices, bank statements, and supporting docs attach to Journals.
 *   - Capital call notices attach to CapitalCall records.
 *   - Subscription agreements attach to Investor records.
 *   - Tax forms (W-9, W-8BEN) attach to Investor.taxInfo.
 *   - Valuation reports attach to Valuation records.
 *   - The audit trail tracks who uploaded, viewed, and downloaded.
 *
 * MIGRATION SOURCE:
 *   Old schemas: File + DocumentRoom + JournalDocument
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
 * Per-user access permission on a document.
 */
const permissionSchema = new Schema(
  {
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
    },
    accessLevel: {
      type: String,
      required: true,
      enum: [
        "OWNER",             // Full control, can delete
        "EDITOR",            // Can edit metadata, replace file
        "VIEWER",            // Can view and download
        "UPLOADER",          // Can upload new versions
        "RESTRICTED",        // Can see metadata but not download
      ],
      default: "VIEWER",
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },
    grantedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

/**
 * Version history entry (for file replacement tracking).
 */
const versionSchema = new Schema(
  {
    versionNumber: { type: Number, required: true },
    storageKey:    { type: String, required: true },
    storageUrl:    { type: String },
    fileSize:      { type: Number },
    mimeType:      { type: String },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },
    uploadedAt: { type: Date, default: Date.now },
    checksum:   { type: String }, // MD5/SHA256 for integrity verification
    notes:      { type: String, maxlength: 500 },
  },
  { _id: true }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const documentSchema = new Schema(
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

    /**
     * Which fund this document belongs to.
     * Null for org-level documents (e.g., firm formation docs).
     */
    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // File identity
    // ------------------------------------------------------------------

    /** Original filename as uploaded: "Invoice_MorganLewis_Q1_2026.pdf" */
    originalName: {
      type: String,
      required: [true, "Original filename is required"],
      trim: true,
      maxlength: 500,
    },

    /** System-generated unique filename (for storage key) */
    storageKey: {
      type: String,
      trim: true,
    },

    /** CDN or signed URL for access */
    storageUrl: {
      type: String,
      trim: true,
    },

    /** File size in bytes */
    fileSize: {
      type: Number,
    },

    /** MIME type: "application/pdf", "image/png", etc. */
    mimeType: {
      type: String,
      trim: true,
    },

    /** File extension: "pdf", "xlsx", "docx", "png" */
    fileExtension: {
      type: String,
      trim: true,
      lowercase: true,
    },

    /** Checksum for integrity verification */
    checksum: { type: String },

    // ------------------------------------------------------------------
    // Classification (replaces 15+ boolean flags)
    // ------------------------------------------------------------------

    /**
     * What kind of document is this?
     * Single enum replaces isCapitalCall, isDistribution, isPartner,
     * isAccounting, isInvestment, isInvoice, isSignedDocument, etc.
     */
    category: {
      type: String,
      required: true,
      enum: [
        // Fund operations
        "CAPITAL_CALL",         // Call notice, wire instructions
        "DISTRIBUTION",         // Distribution notice
        "INVESTMENT",           // SPA, term sheet, closing docs
        "VALUATION",            // Valuation report, supporting analysis

        // Investor / LP
        "INVESTOR",             // Subscription agreement, side letter
        "ONBOARDING",           // KYC docs, accreditation, ID verification
        "TAX",                  // W-9, W-8BEN, K-1

        // Accounting
        "ACCOUNTING",           // Journal support, working papers
        "INVOICE",              // Vendor invoices
        "BANK_STATEMENT",       // Bank statements
        "RECEIPT",              // Expense receipts

        // Legal & compliance
        "LEGAL",                // LPA, amendments, legal opinions
        "COMPLIANCE",           // Compliance reports, regulatory filings
        "FORMATION",            // Fund formation documents

        // Signed documents
        "SIGNED",               // E-signed documents (SignNow, DocuSign)
        "FINANCING",            // Credit facility, loan docs

        // Reports
        "REPORT",               // Generated reports, financial statements
        "TEMPLATE",             // Report templates

        // General
        "GENERAL",              // Uncategorized / general files
        "OTHER",
      ],
      default: "GENERAL",
    },

    /** Free-text document type for more specific classification */
    documentType: {
      type: String,
      trim: true,
      maxlength: 100,
    },

    // ------------------------------------------------------------------
    // Folder placement
    // ------------------------------------------------------------------

    folderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
      index: true,
    },

    // ------------------------------------------------------------------
    // Entity linkage (what business object does this document relate to?)
    // ------------------------------------------------------------------

    /** Linked investor (subscription docs, tax forms, KYC) */
    investorId: {
      type: Schema.Types.ObjectId,
      ref: "Investor",
      default: null,
    },

    /** Linked investment / portfolio company */
    investmentId: {
      type: Schema.Types.ObjectId,
      ref: "Investment",
      default: null,
    },

    /** Linked journal entry (supporting doc for a journal) */
    journalId: {
      type: Schema.Types.ObjectId,
      ref: "Journal",
      default: null,
    },

    /** Linked capital call */
    capitalCallId: {
      type: Schema.Types.ObjectId,
      ref: "CapitalCall",
      default: null,
    },

    /** Linked distribution */
    distributionId: {
      type: Schema.Types.ObjectId,
      ref: "Distribution",
      default: null,
    },

    /** Linked valuation */
    valuationId: {
      type: Schema.Types.ObjectId,
      ref: "Valuation",
      default: null,
    },

    /** Linked activity (workflow item that produced/consumed this doc) */
    activityId: {
      type: Schema.Types.ObjectId,
      ref: "Activity",
      default: null,
    },

    // ------------------------------------------------------------------
    // Processing pipeline (replaces fileType: STAGING→DIRECT)
    // ------------------------------------------------------------------

    /**
     * Where is this document in the processing pipeline?
     *
     * UPLOADED:    File uploaded, not yet processed
     * PROCESSING:  AI is parsing / classifying the document
     * CLASSIFIED:  AI classified it, awaiting human review
     * ACTIVE:      Reviewed and active in the system
     * DUPLICATE:   Detected as duplicate of another document
     * FAILED:      Processing failed
     * ARCHIVED:    No longer active but retained for records
     */
    processingStatus: {
      type: String,
      enum: [
        "UPLOADED",
        "PROCESSING",
        "CLASSIFIED",
        "ACTIVE",
        "DUPLICATE",
        "FAILED",
        "ARCHIVED",
      ],
      default: "UPLOADED",
    },

    /** If duplicate, link to the original */
    duplicateOfId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },

    // ------------------------------------------------------------------
    // E-signature tracking
    // ------------------------------------------------------------------

    eSign: {
      /** Is this document signed? */
      isSigned:       { type: Boolean, default: false },
      /** E-sign provider */
      provider:       { type: String, enum: ["SIGNNOW", "DOCUSIGN", "HELLOSIGN", "MANUAL"] },
      /** Provider's document ID */
      providerDocId:  { type: String },
      /** When it was signed */
      signedAt:       { type: Date },
      /** Approval status after signing */
      approvalStatus: {
        type: String,
        enum: ["PENDING_APPROVAL", "APPROVED", "REJECTED"],
      },
      approvedBy:     { type: Schema.Types.ObjectId, ref: "Identity" },
      approvedAt:     { type: Date },
    },

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    /**
     * Per-user permissions. If empty, access is determined by the
     * fund/org role of the requesting user (default behavior).
     * If populated, only listed users have access.
     */
    permissions: [permissionSchema],

    /**
     * Visibility scope:
     *   FUND_TEAM:   Visible to all fund team members
     *   INVESTORS:   Visible to investors of the linked fund
     *   SPECIFIC:    Only visible to users in permissions[]
     *   PUBLIC:      Accessible via shared link (data room)
     */
    visibility: {
      type: String,
      enum: ["FUND_TEAM", "INVESTORS", "SPECIFIC", "PUBLIC"],
      default: "FUND_TEAM",
    },

    // ------------------------------------------------------------------
    // AI processing
    // ------------------------------------------------------------------

    /** AI-extracted fields from document parsing */
    aiExtractedData: {
      type: Schema.Types.Mixed,
    },

    /** AI confidence in extraction (0-1) */
    aiConfidence: { type: Number, min: 0, max: 1 },

    /** Raw text extracted by OCR/parsing */
    extractedText: {
      type: String,
      select: false, // Large field, don't include by default
    },

    /** Page count (for PDFs) */
    pageCount: { type: Number },

    // ------------------------------------------------------------------
    // Versioning
    // ------------------------------------------------------------------

    /** Current version number */
    currentVersion: {
      type: Number,
      default: 1,
    },

    /** Version history */
    versions: [versionSchema],

    // ------------------------------------------------------------------
    // User interaction
    // ------------------------------------------------------------------

    /** Is this document favorited by the owner? */
    isFavorite: {
      type: Boolean,
      default: false,
    },

    /** Last time anyone opened/viewed this document */
    lastAccessedAt: {
      type: Date,
    },

    /** Description or notes about this document */
    description: {
      type: String,
      maxlength: 2000,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: "Identity" },

    // ------------------------------------------------------------------
    // External references (for migration / integrations)
    // ------------------------------------------------------------------

    /** QuickBooks document ID */
    quickbooksDocId: { type: String },

    /** Bank feed document reference */
    bankfeedDocId: { type: String },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    tags: [{ type: String, trim: true, lowercase: true }],

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "documents",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        delete ret.extractedText; // Never send in JSON responses
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Primary query: documents in a fund by category */
documentSchema.index({ fundId: 1, category: 1, isDeleted: 1 });

/** Folder contents */
documentSchema.index({ folderId: 1, isDeleted: 1, createdAt: -1 });

/** Documents for a specific investor (subscription docs, tax forms) */
documentSchema.index({ investorId: 1, isDeleted: 1 });

/** Documents for a specific investment (SPAs, term sheets) */
documentSchema.index({ investmentId: 1, isDeleted: 1 });

/** Journal supporting documents (replaces JournalDocument collection) */
documentSchema.index({ journalId: 1, isDeleted: 1 });

/** Capital call / distribution notices */
documentSchema.index({ capitalCallId: 1 }, { sparse: true });
documentSchema.index({ distributionId: 1 }, { sparse: true });

/** Activity-linked documents */
documentSchema.index({ activityId: 1 }, { sparse: true });

/** Processing pipeline queue */
documentSchema.index({ organizationId: 1, processingStatus: 1 });

/** Favorites and recent */
documentSchema.index({ fundId: 1, isFavorite: 1, isDeleted: 1 });
documentSchema.index({ fundId: 1, lastAccessedAt: -1, isDeleted: 1 });

/** Org-wide document search */
documentSchema.index({ organizationId: 1, isDeleted: 1, createdAt: -1 });

/** Original name search */
documentSchema.index({ organizationId: 1, originalName: 1, isDeleted: 1 });

/** Duplicate detection */
documentSchema.index({ duplicateOfId: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

documentSchema.virtual("name").get(function () {
  return this.originalName;
});

documentSchema.virtual("isImage").get(function () {
  return this.mimeType?.startsWith("image/") || false;
});

documentSchema.virtual("isPdf").get(function () {
  return this.mimeType === "application/pdf";
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(documentSchema, {
  modelName: "Document",
  category: "DOCUMENT",
  getLabel: (doc) => doc.originalName,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("Document", documentSchema);
