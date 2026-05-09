/**
 * ============================================================================
 * VCFO MIDDLEWARE: auditMiddleware
 * ============================================================================
 *
 * HOW TO USE:
 *   const auditMiddleware = require("../middleware/auditMiddleware");
 *   auditMiddleware(mySchema, {
 *     modelName: "Organization",
 *     category: "ORGANIZATION",
 *     getLabel: (doc) => doc.name,
 *     redactFields: ["billing.stripeCustomerId"],
 *   });
 *
 * WHAT IT DOES:
 *   Attaches Mongoose middleware (pre/post hooks) to a schema so that
 *   every save, update, and delete automatically writes an AuditTrail
 *   document. No manual audit logging needed in controllers.
 *
 * HOW IT WORKS:
 *   1. On `pre('save')`, captures the original document (for updates)
 *   2. On `post('save')`, computes the diff and writes AuditTrail entry
 *   3. On `pre('findOneAndUpdate')`, captures before-state
 *   4. On `post('findOneAndUpdate')`, captures after-state and writes diff
 *   5. On `pre('findOneAndDelete')`, captures document for DELETE audit
 *
 * CONTEXT PASSING:
 *   The middleware needs to know WHO performed the action (identityId),
 *   WHICH org/fund it belongs to, and optionally WHY. This is passed
 *   via Mongoose's `options` or via the `$locals` on the document:
 *
 *   // Option A: document save
 *   doc.$locals.auditContext = {
 *     performedBy: req.identity._id,
 *     organizationId: req.params.orgId,
 *     fundId: req.params.fundId,       // optional
 *     reason: "Correcting FX rate",    // optional
 *     source: "UI",                    // optional, defaults to "UI"
 *     correlationId: req.correlationId, // optional
 *     ipAddress: req.ip,               // optional
 *   };
 *   await doc.save();
 *
 *   // Option B: query update
 *   await Model.findOneAndUpdate(
 *     { _id: id },
 *     { $set: { status: "ACTIVE" } },
 *     {
 *       new: true,
 *       auditContext: { performedBy, organizationId, ... }
 *     }
 *   );
 *
 * SENSITIVE FIELD REDACTION:
 *   Fields listed in `redactFields` will have their values replaced with
 *   "[REDACTED]" in the audit trail. Use for passwords, bank account
 *   numbers, SSNs, 2FA secrets, etc.
 *
 * SKIPPING AUDIT:
 *   Set `{ skipAudit: true }` in options to bypass audit logging for
 *   a specific operation (e.g., bulk migrations where you write audit
 *   entries manually).
 *
 * ============================================================================
 */

const mongoose = require("mongoose");

/**
 * Fields that are ALWAYS redacted regardless of per-schema config.
 * These should never appear in plain text in any audit trail.
 */
const GLOBAL_REDACT_FIELDS = [
  "passwordHash",
  "password",
  "twoFactor.secret",
  "twoFactor.backupCodes",
  "cognitoSub",
  "ssn",
  "ein",
  "socialSecurityNumber",
  "snnOrTaxId",
];

/**
 * Fields that change frequently but carry no audit significance.
 * Excluding them reduces noise in the audit trail.
 */
const IGNORED_FIELDS = [
  "updatedAt",
  "__v",
  "lastLoginAt",
  "lastActiveAt",
];

/**
 * Attach audit middleware to a Mongoose schema.
 *
 * @param {mongoose.Schema} schema - The schema to attach to
 * @param {Object} options
 * @param {string} options.modelName - The model name for targetModel field
 * @param {string} options.category - The AUDIT_CATEGORIES value
 * @param {Function} [options.getLabel] - Function(doc) → string for targetLabel
 * @param {string[]} [options.redactFields] - Additional fields to redact
 * @param {Function} [options.getOrgId] - Function(doc) → ObjectId for organizationId
 * @param {Function} [options.getFundId] - Function(doc) → ObjectId for fundId
 */
function auditMiddleware(schema, options = {}) {
  const {
    modelName = "Unknown",
    category = "SYSTEM",
    getLabel = null,
    redactFields = [],
    getOrgId = (doc) => doc.organizationId || null,
    getFundId = (doc) => doc.fundId || null,
  } = options;

  const allRedactFields = [...GLOBAL_REDACT_FIELDS, ...redactFields];

  // =========================================================================
  // DOCUMENT MIDDLEWARE — save()
  // =========================================================================

  /**
   * Pre-save: capture the original state for diffing.
   * On new documents, _original will be null → action = CREATE.
   * On existing documents, we fetch the current DB state.
   */
  schema.pre("save", async function (next) {
    if (this.$locals?.skipAudit || this.$__.skipAudit) return next();

    if (this.isNew) {
      this.$locals._auditAction = "CREATE";
      this.$locals._auditOriginal = null;
    } else {
      this.$locals._auditAction = "UPDATE";
      try {
        const Model = mongoose.model(modelName);
        const original = await Model.findById(this._id).lean();
        this.$locals._auditOriginal = original;
      } catch (err) {
        // If we can't fetch original, still proceed but log without diff
        this.$locals._auditOriginal = null;
      }
    }
    next();
  });

  /**
   * Post-save: compute diff and write AuditTrail entry.
   */
  schema.post("save", async function (doc) {
    if (doc.$locals?.skipAudit) return;

    const ctx = doc.$locals?.auditContext || {};
    if (!ctx.performedBy) return; // Can't audit without knowing who

    const action = doc.$locals._auditAction || "UPDATE";
    const original = doc.$locals._auditOriginal;

    let changes;
    if (action === "CREATE") {
      changes = buildCreateSnapshot(doc.toObject(), allRedactFields);
    } else {
      changes = buildDiff(original, doc.toObject(), allRedactFields);
      if (!changes || Object.keys(changes).length === 0) return; // No real changes
    }

    await writeAuditEntry({
      organizationId: ctx.organizationId || getOrgId(doc),
      fundId: ctx.fundId || getFundId(doc),
      performedBy: ctx.performedBy,
      actorSnapshot: ctx.actorSnapshot || {},
      action: mapToAuditAction(action, doc),
      category,
      targetModel: modelName,
      targetId: doc._id,
      targetLabel: getLabel ? getLabel(doc) : undefined,
      changes,
      reason: ctx.reason,
      source: ctx.source || "UI",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
  });

  // =========================================================================
  // QUERY MIDDLEWARE — findOneAndUpdate, updateOne, updateMany
  // =========================================================================

  schema.pre("findOneAndUpdate", async function (next) {
    const opts = this.getOptions();
    if (opts.skipAudit) return next();
    if (!opts.auditContext?.performedBy) return next();

    try {
      const original = await this.model.findOne(this.getFilter()).lean();
      this._auditOriginal = original;
    } catch (err) {
      this._auditOriginal = null;
    }
    next();
  });

  schema.post("findOneAndUpdate", async function (doc) {
    const opts = this.getOptions();
    if (opts.skipAudit || !doc) return;

    const ctx = opts.auditContext;
    if (!ctx?.performedBy) return;

    const original = this._auditOriginal;
    const changes = buildDiff(original, doc.toObject ? doc.toObject() : doc, allRedactFields);
    if (!changes || Object.keys(changes).length === 0) return;

    await writeAuditEntry({
      organizationId: ctx.organizationId || getOrgId(doc),
      fundId: ctx.fundId || getFundId(doc),
      performedBy: ctx.performedBy,
      actorSnapshot: ctx.actorSnapshot || {},
      action: mapToAuditAction("UPDATE", doc),
      category,
      targetModel: modelName,
      targetId: doc._id,
      targetLabel: getLabel ? getLabel(doc) : undefined,
      changes,
      reason: ctx.reason,
      source: ctx.source || "UI",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
  });

  // =========================================================================
  // DELETE MIDDLEWARE — findOneAndDelete
  // =========================================================================

  schema.pre("findOneAndDelete", async function (next) {
    const opts = this.getOptions();
    if (opts.skipAudit) return next();
    if (!opts.auditContext?.performedBy) return next();

    try {
      const doc = await this.model.findOne(this.getFilter()).lean();
      this._auditDeletedDoc = doc;
    } catch (err) {
      this._auditDeletedDoc = null;
    }
    next();
  });

  schema.post("findOneAndDelete", async function (doc) {
    const opts = this.getOptions();
    if (opts.skipAudit) return;

    const ctx = opts.auditContext;
    if (!ctx?.performedBy) return;

    const deletedDoc = this._auditDeletedDoc || doc;
    if (!deletedDoc) return;

    const changes = buildCreateSnapshot(deletedDoc, allRedactFields);

    await writeAuditEntry({
      organizationId: ctx.organizationId || getOrgId(deletedDoc),
      fundId: ctx.fundId || getFundId(deletedDoc),
      performedBy: ctx.performedBy,
      actorSnapshot: ctx.actorSnapshot || {},
      action: "DELETE",
      category,
      targetModel: modelName,
      targetId: deletedDoc._id,
      targetLabel: getLabel ? getLabel(deletedDoc) : undefined,
      changes,
      reason: ctx.reason,
      source: ctx.source || "UI",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
  });
}

// ===========================================================================
// Helper functions
// ===========================================================================

/**
 * Write an audit trail entry. Uses the AuditTrail model directly.
 * Wrapped in try/catch — audit failures must NEVER crash the main operation.
 */
async function writeAuditEntry(data) {
  try {
    const AuditTrail = mongoose.model("AuditTrail");
    await AuditTrail.create(data);
  } catch (err) {
    // Log to console but NEVER throw — audit failure must not block operations
    console.error("[AuditTrail] Failed to write audit entry:", err.message, {
      targetModel: data.targetModel,
      targetId: data.targetId,
      action: data.action,
    });
  }
}

/**
 * Build a snapshot for CREATE/DELETE events.
 * Returns { fieldName: { after: value } } for CREATE
 * or { fieldName: { before: value } } for DELETE.
 */
function buildCreateSnapshot(doc, redactFields) {
  const snapshot = {};
  const flat = flattenObject(doc);

  for (const [key, value] of Object.entries(flat)) {
    if (IGNORED_FIELDS.includes(key)) continue;
    if (key === "_id" || key === "id") continue;

    const displayValue = shouldRedact(key, redactFields) ? "[REDACTED]" : value;
    snapshot[key] = { after: displayValue };
  }
  return snapshot;
}

/**
 * Build a diff between old and new document states.
 * Returns only fields that changed: { fieldName: { before, after } }
 */
function buildDiff(original, updated, redactFields) {
  if (!original) return null;

  const oldFlat = flattenObject(original);
  const newFlat = flattenObject(updated);
  const diff = {};

  const allKeys = new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)]);

  for (const key of allKeys) {
    if (IGNORED_FIELDS.includes(key)) continue;
    if (key === "_id" || key === "id") continue;

    const oldVal = oldFlat[key];
    const newVal = newFlat[key];

    // Compare stringified to handle ObjectId, Date, Decimal128, etc.
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      if (shouldRedact(key, redactFields)) {
        diff[key] = { before: "[REDACTED]", after: "[REDACTED]" };
      } else {
        diff[key] = { before: oldVal ?? null, after: newVal ?? null };
      }
    }
  }

  return diff;
}

/**
 * Flatten a nested object into dot-notation keys.
 * { a: { b: 1 } } → { "a.b": 1 }
 * Handles arrays by index: { arr: [1,2] } → { "arr.0": 1, "arr.1": 2 }
 */
function flattenObject(obj, prefix = "", result = {}) {
  if (!obj || typeof obj !== "object") return result;

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value) &&
        !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId) &&
        !(value instanceof mongoose.Types.Decimal128)) {
      flattenObject(value, fullKey, result);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Check if a field path should be redacted.
 * Supports dot-notation matching: "twoFactor.secret" matches "twoFactor.secret"
 */
function shouldRedact(fieldPath, redactFields) {
  return redactFields.some((rf) =>
    fieldPath === rf || fieldPath.startsWith(rf + ".") || fieldPath.endsWith("." + rf)
  );
}

/**
 * Map internal action to AUDIT_ACTIONS enum.
 * Handles special cases like status changes.
 */
function mapToAuditAction(action, doc) {
  if (action === "CREATE") return "CREATE";
  if (action === "DELETE") return "DELETE";

  // Check if this is specifically a status change
  if (doc.$locals?._auditOriginal) {
    const oldStatus = doc.$locals._auditOriginal.status;
    const newStatus = doc.status;
    if (oldStatus && newStatus && oldStatus !== newStatus) {
      return "STATUS_CHANGE";
    }
  }
  return "UPDATE";
}

module.exports = auditMiddleware;
