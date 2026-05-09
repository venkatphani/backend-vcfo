/**
 * ============================================================================
 * VCFO SCHEMA: Identity
 * ============================================================================
 *
 * WHAT THIS IS:
 *   A login account — a human who can authenticate with VCFO. Nothing more.
 *   An Identity has no permissions, no fund access, and no accounting role
 *   until linked to an Organization via OrganizationMember and optionally
 *   to a Fund via FundRole.
 *
 * WHY "IDENTITY" AND NOT "USER":
 *   - "User" collides with auth libraries, JWT middleware, and Mongoose
 *     reserved words in many stacks.
 *   - "Account" collides with Chart of Accounts (GL accounts) — the most
 *     important collection in an accounting system.
 *   - "Identity" is clean, unambiguous, and standard in IAM terminology.
 *
 * MENTAL MODEL:
 *   Identity ──► OrganizationMember (1:N — can belong to multiple orgs)
 *            ──► FundRole (1:N via OrganizationMember — access to funds)
 *
 * ACCOUNTING RELEVANCE:
 *   Minimal. Identity is an authentication record. However:
 *   - `_id` is referenced by every audit trail as `performedBy`
 *   - `_id` is referenced by Journal.createdBy, Journal.postedBy
 *   - `timezone` helps resolve date ambiguity in journal entry UIs
 *
 * MIGRATION SOURCE:
 *   Old schema: User → Identity
 *   Old collection: users → identities
 *
 * INDEXES:
 *   - { email: 1 }         unique — login lookup
 *   - { cognitoSub: 1 }    unique, sparse — SSO/Cognito lookup
 *   - { status: 1 }        — filter active identities
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const identitySchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Personal Info
    // ------------------------------------------------------------------

    firstName: { type: String, trim: true, maxlength: 100 },
    lastName:  { type: String, trim: true, maxlength: 100 },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/\S+@\S+\.\S+/, "Invalid email format"],
    },

    /** Profile picture URL */
    avatarUrl: { type: String },

    // ------------------------------------------------------------------
    // Authentication
    // These fields are for the auth system only. Never expose in API
    // responses. Never include in LLM context.
    // ------------------------------------------------------------------

    /** Hashed password (bcrypt). Null if using SSO only. */
    passwordHash: { type: String, default: null, select: false },

    /** AWS Cognito subject ID for SSO integration */
    cognitoSub: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },

    // ------------------------------------------------------------------
    // Two-Factor Authentication
    // ------------------------------------------------------------------

    twoFactor: {
      isEnabled:  { type: Boolean, default: true },
      isVerified: { type: Boolean, default: false },
      /** TOTP secret — NEVER expose in API or LLM context */
      secret:     { type: String, select: false },
      /** Backup codes — NEVER expose */
      backupCodes: { type: [String], select: false, default: undefined },
    },

    // ------------------------------------------------------------------
    // Platform Roles
    // These are VCFO-internal staff roles, NOT business/fund roles.
    // Business roles live on OrganizationMember and FundRole.
    // ------------------------------------------------------------------

    platformRole: {
      type: String,
      enum: [
        "STANDARD",          // Normal identity — default
        "PLATFORM_ADMIN",    // VCFO super admin (was isZiveSuperAdmin)
        "PLATFORM_SUPPORT",  // VCFO support staff (was isZiveServicesAdmin)
        "COMPLIANCE",        // VCFO compliance team (was isZiveCompliance)
      ],
      default: "STANDARD",
    },

    // ------------------------------------------------------------------
    // Preferences
    // ------------------------------------------------------------------

    /** IANA timezone for display and date resolution */
    timezone: {
      type: String,
      default: "America/New_York",
      trim: true,
    },

    /** Preferred date format in reports */
    dateFormat: {
      type: String,
      enum: ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"],
      default: "MM/DD/YYYY",
    },

    /** Preferred number format */
    numberFormat: {
      type: String,
      enum: ["1,234.56", "1.234,56", "1 234.56"],
      default: "1,234.56",
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["ACTIVE", "DEACTIVATED", "LOCKED"],
      default: "ACTIVE",
    },

    lastLoginAt: { type: Date },

    /** Has the identity completed initial registration flow? */
    isRegistered: { type: Boolean, default: false },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "identities",

    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.passwordHash;
        delete ret.cognitoSub;
        delete ret.__v;
        if (ret.twoFactor) {
          delete ret.twoFactor.secret;
          delete ret.twoFactor.backupCodes;
        }
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

identitySchema.index({ email: 1 }, { unique: true });
identitySchema.index({ cognitoSub: 1 }, { unique: true, sparse: true });
identitySchema.index({ status: 1 });
identitySchema.index({ platformRole: 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

identitySchema.virtual("fullName").get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(" ");
});

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

const auditMiddleware = require("../middleware/auditMiddleware");

auditMiddleware(identitySchema, {
  modelName: "Identity",
  category: "AUTH",
  getLabel: (doc) => doc.email,
  redactFields: [
    "passwordHash",
    "cognitoSub",
    "twoFactor.secret",
    "twoFactor.backupCodes",
  ],
  getOrgId: () => null,   // Identity is org-agnostic
  getFundId: () => null,
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = model("Identity", identitySchema);
