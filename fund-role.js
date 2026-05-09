/**
 * ============================================================================
 * VCFO SCHEMA: FundRole
 * ============================================================================
 *
 * WHAT THIS IS:
 *   Fund-level access control. Links an OrganizationMember to a specific Fund
 *   with a fund-scoped role. An ADMIN at the org level can access all funds,
 *   but a non-admin needs explicit FundRole entries.
 *
 * MENTAL MODEL:
 *   Identity ──► OrganizationMember (org-level role)
 *                    ──► FundRole (fund-level role, 0..N per member)
 *
 * WHY THIS EXISTS:
 *   Old Role schema had 500+ fields mixing fund access with LP onboarding,
 *   KYC, banking, and tax. This schema handles ONLY "can this person access
 *   this fund, and with what permissions?"
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const auditMiddleware = require("../middleware/auditMiddleware");

const fundRoleSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
    },

    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      required: true,
      immutable: true,
    },

    /** The org member this fund role belongs to */
    organizationMemberId: {
      type: Schema.Types.ObjectId,
      ref: "OrganizationMember",
      required: true,
      immutable: true,
    },

    /** Direct ref to identity for fast lookups without joining through OrgMember */
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      immutable: true,
    },

    /**
     * Fund-level role.
     *
     * FUND_MANAGER:  Full control over this fund's accounting.
     * ACCOUNTANT:    Can create/post journals, manage CoA.
     * ANALYST:       Read-only financial data access.
     * INVESTOR_VIEW: LP portal access (sees own capital account only).
     */
    role: {
      type: String,
      required: true,
      enum: ["FUND_MANAGER", "ACCOUNTANT", "ANALYST", "INVESTOR_VIEW"],
      default: "ANALYST",
    },

    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED", "REMOVED"],
      default: "ACTIVE",
    },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "fundroles",

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

/** One role per member per fund */
fundRoleSchema.index({ fundId: 1, organizationMemberId: 1 }, { unique: true });

/** "What funds can this identity access?" */
fundRoleSchema.index({ identityId: 1, status: 1 });

/** "Who has access to this fund?" */
fundRoleSchema.index({ fundId: 1, role: 1, status: 1 });

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

auditMiddleware(fundRoleSchema, {
  modelName: "FundRole",
  category: "ACCESS_CONTROL",
  getLabel: (doc) => `${doc.role} on fund`,
  getOrgId: (doc) => doc.organizationId,
  getFundId: (doc) => doc.fundId,
});

module.exports = model("FundRole", fundRoleSchema);
