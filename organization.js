/**
 * ============================================================================
 * VCFO SCHEMA: Organization
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The root tenant in VCFO. An Organization represents a GP firm, fund
 *   administrator, or any top-level entity that manages one or more Funds.
 *   Every other document in the system (Fund, User membership, Journal, etc.)
 *   traces back to an Organization.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) Funds
 *   Organization (1) ──► (N) OrganizationMembers ──► (1) User each
 *   Organization (1) ──► (N) ChartOfAccounts (default templates)
 *
 * WHY IT EXISTS:
 *   The old "Entity" schema tried to be everything — a fund, a dashboard,
 *   a CRM, a billing record, and a feature flag store. This schema separates
 *   the "who owns and operates funds" from "what is a fund." A single GP firm
 *   (Organization) can manage Fund I, Fund II, an SPV, and a co-invest vehicle
 *   without duplicating org-level data.
 *
 * ACCOUNTING RELEVANCE:
 *   - `baseCurrency` is the Organization's reporting currency. Individual Funds
 *     may have different functional currencies, but consolidated reports roll
 *     up to this currency.
 *   - `fiscalYearEndMonth` / `fiscalYearEndDay` set the default fiscal calendar
 *     for new Funds (overridable at Fund level).
 *   - `timezone` ensures journal posting dates are unambiguous.
 *
 * MIGRATION SOURCE:
 *   Old schema: Entity (partial — org-level fields only)
 *   See /docs/migration/001-organization.md for field mapping.
 *
 * INDEXES:
 *   - { slug: 1 }                  unique — URL-safe identifier
 *   - { status: 1, createdAt: -1 } — list active orgs, newest first
 *   - { "billing.stripeCustomerId": 1 } — Stripe webhook lookups
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Address — reusable structured address.
 * RULE: Never store address as a single string. Structured addresses enable
 * tax jurisdiction lookups, compliance checks, and clean report formatting.
 */
const addressSchema = new Schema(
  {
    line1:   { type: String, trim: true },
    line2:   { type: String, trim: true },
    city:    { type: String, trim: true },
    state:   { type: String, trim: true },
    zipCode: { type: String, trim: true },
    country: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 3,
      // ISO 3166-1 alpha-2 or alpha-3 (e.g., "US", "USA", "IN", "IND")
    },
  },
  { _id: false }
);

/**
 * Billing — Stripe / payment integration fields.
 * Isolated so billing concerns don't leak into the core org fields.
 */
const billingSchema = new Schema(
  {
    stripeCustomerId: { type: String, sparse: true },
    plan: {
      type: String,
      enum: ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"],
      default: "FREE",
    },
    lastPaidDate:  { type: Date },
    expiryDate:    { type: Date },
    trialEndsAt:   { type: Date },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const organizationSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /** Human-readable name: "Sequoia Capital", "Acme Fund Admin" */
    name: {
      type: String,
      required: [true, "Organization name is required"],
      trim: true,
      maxlength: 200,
    },

    /**
     * URL-safe unique slug: "sequoia-capital"
     * Used in URLs, API paths, and cross-system references.
     * Immutable after creation to prevent broken links.
     */
    slug: {
      type: String,
      required: [true, "Organization slug is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"],
      maxlength: 100,
    },

    /**
     * What kind of organization this is.
     * Determines defaults, available features, and UI behavior.
     */
    type: {
      type: String,
      required: true,
      enum: [
        "GP",                    // General Partner firm managing funds
        "FUND_ADMIN",            // Third-party fund administrator
        "FAMILY_OFFICE",         // Family office managing own capital
        "ANGEL_GROUP",           // Angel syndicate or group
        "HOLDING_COMPANY",       // Holding company structure
      ],
    },

    // ------------------------------------------------------------------
    // Branding
    // ------------------------------------------------------------------

    logo:            { type: String },  // URL to logo image
    backgroundImage: { type: String },  // URL to brand background

    // ------------------------------------------------------------------
    // Contact & Legal
    // ------------------------------------------------------------------

    email:   { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    phone:   { type: String, trim: true },

    /** Registered legal address of the organization */
    legalAddress: { type: addressSchema },

    /** Primary domicile / jurisdiction for regulatory purposes */
    domicile: {
      type: String,
      trim: true,
      uppercase: true,
      // ISO 3166-1 alpha-2 (e.g., "US", "KY", "LU")
    },

    /** Tax identification number of the organization entity */
    taxId: {
      type: String,
      trim: true,
      // EIN in US, equivalent in other jurisdictions
    },

    yearFounded: { type: Number, min: 1800, max: 2100 },

    // ------------------------------------------------------------------
    // Accounting Defaults
    // These cascade to new Funds but can be overridden at Fund level.
    // ------------------------------------------------------------------

    /**
     * Organization's base reporting currency (ISO 4217).
     * All consolidated reports across funds use this currency.
     * Individual funds may have different functional currencies.
     *
     * ACCOUNTING RULE: This is the "reporting currency" in ASC 830 terms.
     * FX translation from fund functional currency → org reporting currency
     * happens at consolidation time using period-end rates for balance sheet
     * items and average rates for income/expense items.
     */
    baseCurrency: {
      type: String,
      required: [true, "Base currency is required"],
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: "USD",
      // ISO 4217: "USD", "EUR", "GBP", "INR", etc.
    },

    /**
     * Default fiscal year end for new funds.
     * Most funds use Dec 31 (month: 12, day: 31) but some jurisdictions
     * or fund structures use different year-ends (e.g., March 31 in India).
     */
    fiscalYearEndMonth: {
      type: Number,
      min: 1,
      max: 12,
      default: 12,
    },
    fiscalYearEndDay: {
      type: Number,
      min: 1,
      max: 31,
      default: 31,
    },

    /**
     * Default accounting standard for new funds.
     * Can be overridden per fund (e.g., a Cayman SPV might use IFRS
     * while the main US fund uses US GAAP).
     */
    defaultAccountingStandard: {
      type: String,
      enum: ["US_GAAP_ASC946", "IFRS", "IND_AS", "OTHER"],
      default: "US_GAAP_ASC946",
    },

    /**
     * IANA timezone: "America/New_York", "Asia/Kolkata", etc.
     * Used to resolve "today" for journal posting dates and period cutoffs.
     * Critical for orgs operating across time zones.
     */
    timezone: {
      type: String,
      default: "America/New_York",
      trim: true,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED", "DEACTIVATED"],
      default: "ACTIVE",
    },

    /**
     * The User who originally created this Organization.
     * Immutable — for audit trail. Current admins are tracked via
     * OrganizationMember with role = ADMIN.
     */
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Billing
    // ------------------------------------------------------------------

    billing: { type: billingSchema },

    // ------------------------------------------------------------------
    // Feature Configuration
    // Replaces the 30+ boolean flags scattered across old Entity.
    // Stored as a structured object so new features don't require
    // schema migration — just add a key with a default.
    // ------------------------------------------------------------------

    features: {
      multiCurrency:    { type: Boolean, default: false },
      bankFeedSync:     { type: Boolean, default: false },
      aiJournalEntry:   { type: Boolean, default: false },
      lpPortalAccess:   { type: Boolean, default: true },
      cryptoTracking:   { type: Boolean, default: false },
      customReports:    { type: Boolean, default: false },
      auditWorkflow:    { type: Boolean, default: false },
    },

    // ------------------------------------------------------------------
    // Extensibility
    // For client-specific or integration-specific data that doesn't
    // warrant a schema field. Use sparingly — prefer explicit fields.
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,  // createdAt, updatedAt auto-managed

    /**
     * When this document is sent to the API or to an LLM context,
     * include virtuals and strip Mongoose internals.
     */
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/**
 * Primary lookup: find org by slug (unique).
 * Used in: every API route that resolves /:orgSlug/...
 */
organizationSchema.index({ slug: 1 }, { unique: true });

/**
 * List active organizations, newest first.
 * Used in: admin dashboards, org selection screens.
 */
organizationSchema.index({ status: 1, createdAt: -1 });

/**
 * Stripe webhook lookups: find org by Stripe customer ID.
 * Sparse because not every org has billing set up.
 */
organizationSchema.index(
  { "billing.stripeCustomerId": 1 },
  { sparse: true }
);

/**
 * Find all orgs created by a specific user.
 * Used in: "Your organizations" screen after login.
 */
organizationSchema.index({ createdBy: 1 });

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

/**
 * Virtual: formatted fiscal year end string.
 * Useful in reports and UI: "December 31", "March 31"
 */
organizationSchema.virtual("fiscalYearEndDisplay").get(function () {
  const months = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[this.fiscalYearEndMonth] || ""} ${this.fiscalYearEndDay || ""}`.trim();
});

// ---------------------------------------------------------------------------
// Pre-save hooks
// ---------------------------------------------------------------------------

/**
 * Auto-generate slug from name if not provided.
 */
organizationSchema.pre("validate", function (next) {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
  next();
});

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

const auditMiddleware = require("../middleware/auditMiddleware");

auditMiddleware(organizationSchema, {
  modelName: "Organization",
  category: "ORGANIZATION",
  getLabel: (doc) => doc.name || doc.slug,
  redactFields: ["billing.stripeCustomerId", "taxId"],
  getOrgId: (doc) => doc._id,  // Organization IS the org
  getFundId: () => null,       // Org-level, no fund
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = model("Organization", organizationSchema);
