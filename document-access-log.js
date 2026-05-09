/**
 * ============================================================================
 * VCFO SCHEMA: DocumentAccessLog
 * ============================================================================
 *
 * WHAT THIS IS:
 *   An append-only log of every view and download of a Document.
 *   Used for compliance (LP data room access tracking), security
 *   (who accessed sensitive documents), and analytics (most viewed docs).
 *
 * MENTAL MODEL:
 *   Document (1) ──► (N) DocumentAccessLog entries
 *
 * WHY SEPARATE FROM AUDIT TRAIL:
 *   AuditTrail tracks data CHANGES (create, update, delete).
 *   DocumentAccessLog tracks READ ACCESS (view, download).
 *   A document being viewed is not a data change — it's an access event.
 *   Keeping them separate avoids bloating AuditTrail with high-frequency
 *   read events and allows document-specific access analytics.
 *
 * ACCOUNTING RELEVANCE:
 *   - Data room access logs are required for LP reporting and compliance.
 *   - "Who downloaded the K-1?" is a common audit question.
 *   - Fund formation docs, side letters, and subscription agreements
 *     need access tracking for regulatory compliance.
 *
 * MIGRATION SOURCE:
 *   Old schema: DocumentAccessLog (minor ref updates only)
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const documentAccessLogSchema = new Schema(
  {
    // ------------------------------------------------------------------
    // Scope
    // ------------------------------------------------------------------

    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    fundId: {
      type: Schema.Types.ObjectId,
      ref: "Fund",
      default: null,
    },

    // ------------------------------------------------------------------
    // What was accessed
    // ------------------------------------------------------------------

    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },

    /** Denormalized for fast reads without joining */
    documentName: {
      type: String,
    },

    /** Folder the document was in at time of access */
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
    },

    // ------------------------------------------------------------------
    // Who accessed it
    // ------------------------------------------------------------------

    accessedBy: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      index: true,
    },

    /** Denormalized actor info */
    actorSnapshot: {
      email:    { type: String },
      fullName: { type: String },
      role:     { type: String },
    },

    // ------------------------------------------------------------------
    // What action
    // ------------------------------------------------------------------

    action: {
      type: String,
      required: true,
      enum: [
        "VIEW",            // Opened / previewed the document
        "DOWNLOAD",        // Downloaded a copy
        "PRINT",           // Printed (if trackable)
        "SHARE",           // Shared via link or email
        "LINK_ACCESS",     // Accessed via a shared/public link
      ],
    },

    // ------------------------------------------------------------------
    // Context
    // ------------------------------------------------------------------

    /** Where did the access happen from? */
    source: {
      type: String,
      enum: [
        "WEB_APP",         // Main web application
        "LP_PORTAL",       // LP portal / data room
        "API",             // Direct API access
        "MOBILE",          // Mobile app
        "SHARED_LINK",     // Public/shared link
      ],
      default: "WEB_APP",
    },

    /** IP address for security tracking */
    ipAddress: { type: String },

    /** User agent */
    userAgent: { type: String },

    // ------------------------------------------------------------------
    // Timestamp
    // ------------------------------------------------------------------

    accessedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
      index: true,
    },
  },
  {
    timestamps: false, // Using accessedAt instead
    collection: "documentaccesslogs",

    toJSON: {
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

/** Access log for a specific document (most common query) */
documentAccessLogSchema.index({ documentId: 1, accessedAt: -1 });

/** All access by a specific person */
documentAccessLogSchema.index({ accessedBy: 1, accessedAt: -1 });

/** Org-wide access log (compliance dashboard) */
documentAccessLogSchema.index({ organizationId: 1, accessedAt: -1 });

/** Fund-specific access log */
documentAccessLogSchema.index({ fundId: 1, accessedAt: -1 });

/** Access by action type (all downloads in a period) */
documentAccessLogSchema.index({ organizationId: 1, action: 1, accessedAt: -1 });

// ---------------------------------------------------------------------------
// Write-only enforcement (same pattern as AuditTrail)
// ---------------------------------------------------------------------------

documentAccessLogSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function () {
  throw new Error("DocumentAccessLog entries are immutable. Updates are not allowed.");
});

documentAccessLogSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  throw new Error("DocumentAccessLog entries are immutable. Deletes are not allowed.");
});

module.exports = model("DocumentAccessLog", documentAccessLogSchema);
