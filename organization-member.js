/**
 * ============================================================================
 * VCFO SCHEMA: OrganizationMember
 * ============================================================================
 *
 * WHAT THIS IS:
 *   The join table between Identity and Organization. Defines WHO has access
 *   to an Organization and WHAT they can do at the org level. This does NOT
 *   control fund-level access — that's FundRole.
 *
 * MENTAL MODEL:
 *   Identity ──► OrganizationMember ──► Organization
 *                    │
 *                    └──► FundRole (1:N — what funds they can access)
 *
 *   An Identity with an OrganizationMember record can see the org dashboard.
 *   An Identity with a FundRole can access specific funds within that org.
 *   An ADMIN OrganizationMember can manage all funds.
 *
 * WHY THIS EXISTS:
 *   Old schema: the Role collection handled everything — org access, fund
 *   roles, LP onboarding, KYC, banking, tax forms, accreditation. It was
 *   500+ fields. This schema handles ONLY the identity ↔ org relationship.
 *
 * ACCOUNTING RELEVANCE:
 *   - `role` determines who can post journals (ADMIN, ACCOUNTANT),
 *     who can approve them (ADMIN, PARTNER), and who can only view (VIEWER).
 *   - `role` is checked at the application layer before any write operation.
 *   - Journal audit trails reference Identity._id, not OrganizationMember._id.
 *
 * MIGRATION SOURCE:
 *   Old schema: Role (partial — org-level fields only)
 *   A single old Role may produce both an OrganizationMember AND a FundRole.
 *
 * INDEXES:
 *   - { organizationId: 1, identityId: 1 }  unique — one membership per identity per org
 *   - { identityId: 1 }                      — "which orgs does this identity belong to?"
 *   - { organizationId: 1, role: 1 }         — "list all admins of this org"
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const organizationMemberSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Core relationship
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
    },

    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    // ------------------------------------------------------------------
    // Organization-level role
    // ------------------------------------------------------------------

    /**
     * What can this user do WITHIN this organization?
     *
     * OWNER:      Full control. Can delete the org. Can transfer ownership.
     *             Only one per org (enforced in application layer).
     *
     * ADMIN:      Manage funds, users, settings. Can post/approve journals
     *             across all funds. Cannot delete the org.
     *
     * PARTNER:    GP partner. Can view all funds, approve journals,
     *             but cannot manage org settings or users.
     *
     * ACCOUNTANT: Can create, edit, and post journals. Can manage chart of
     *             accounts and periods. Cannot manage users or org settings.
     *
     * ANALYST:    Read-only access to financial data across authorized funds.
     *             Cannot create or modify any accounting data.
     *
     * VIEWER:     Read-only. Can see dashboards and reports they're given
     *             access to. Cannot see raw journal data.
     */
    role: {
      type: String,
      required: true,
      enum: ["OWNER", "ADMIN", "PARTNER", "ACCOUNTANT", "ANALYST", "VIEWER"],
      default: "VIEWER",
    },

    // ------------------------------------------------------------------
    // Status & invitation
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: [
        "INVITED",    // invitation sent, not yet accepted
        "ACTIVE",     // accepted and active
        "SUSPENDED",  // temporarily disabled
        "REMOVED",    // soft-deleted — kept for audit trail
      ],
      default: "INVITED",
    },

    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
    },

    invitedAt:  { type: Date },
    acceptedAt: { type: Date },

    // ------------------------------------------------------------------
    // Activity tracking
    // ------------------------------------------------------------------

    lastActiveAt: { type: Date },

    // ------------------------------------------------------------------
    // Notification preferences (org-scoped)
    // ------------------------------------------------------------------

    notifications: {
      journalApprovals: { type: Boolean, default: true },
      capitalActivity:  { type: Boolean, default: true },
      reportGeneration: { type: Boolean, default: false },
      taskAssignments:  { type: Boolean, default: true },
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,

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

/**
 * Unique membership: one identity can have exactly one role per organization.
 * Prevents duplicate memberships.
 */
organizationMemberSchema.index(
  { organizationId: 1, identityId: 1 },
  { unique: true }
);

/**
 * "Which orgs does this identity belong to?" — used at login to show org picker.
 * Includes status so we can filter to ACTIVE only.
 */
organizationMemberSchema.index({ identityId: 1, status: 1 });

/**
 * "List all admins/accountants of this org" — used for permission checks
 * and journal approval routing.
 */
organizationMemberSchema.index({ organizationId: 1, role: 1, status: 1 });

// ---------------------------------------------------------------------------
// Statics — permission helper
// ---------------------------------------------------------------------------

/**
 * Quick permission check: can this identity perform this action in this org?
 *
 * Usage:
 *   const canPost = await OrganizationMember.canPerform(orgId, identityId, "POST_JOURNAL");
 */
organizationMemberSchema.statics.canPerform = async function (orgId, identityId, action) {
  const member = await this.findOne({
    organizationId: orgId,
    identityId: identityId,
    status: "ACTIVE",
  }).lean();

  if (!member) return false;

  const permissions = {
    OWNER:      ["*"],
    ADMIN:      ["MANAGE_USERS", "MANAGE_FUNDS", "MANAGE_SETTINGS", "POST_JOURNAL", "APPROVE_JOURNAL", "VIEW_ALL"],
    PARTNER:    ["APPROVE_JOURNAL", "VIEW_ALL"],
    ACCOUNTANT: ["POST_JOURNAL", "MANAGE_COA", "MANAGE_PERIODS", "VIEW_ALL"],
    ANALYST:    ["VIEW_ALL"],
    VIEWER:     ["VIEW_DASHBOARD"],
  };

  const allowed = permissions[member.role] || [];
  return allowed.includes("*") || allowed.includes(action);
};

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

const auditMiddleware = require("../middleware/auditMiddleware");

auditMiddleware(organizationMemberSchema, {
  modelName: "OrganizationMember",
  category: "ACCESS_CONTROL",
  getLabel: (doc) => `${doc.role} membership`,
  redactFields: [],
  getOrgId: (doc) => doc.organizationId,
  getFundId: () => null,
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = model("OrganizationMember", organizationMemberSchema);
