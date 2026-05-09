/**
 * ============================================================================
 * VCFO SCHEMA: AiConversation
 * ============================================================================
 *
 * WHAT THIS IS:
 *   An AI chat conversation. Replaces ChatHistory, FileChatHistory, and
 *   DocumentStudio with a single unified schema. Every AI interaction
 *   that involves a back-and-forth conversation lives here.
 *
 * MENTAL MODEL:
 *   Organization (1) ──► (N) AiConversation
 *   AiConversation (1) ──► (N) messages (embedded array)
 *   AiConversation (0..1) ──► Document (if chat is about a document)
 *   AiConversation (0..N) ──► AiUsageLog (token tracking per AI call)
 *
 * WHY UNIFIED:
 *   Old system had three separate schemas for AI chat:
 *   - ChatHistory: general Q&A
 *   - FileChatHistory: Q&A about a specific file
 *   - DocumentStudio: document upload + chat sessions
 *
 *   All three are the same concept — a conversation with AI, optionally
 *   in the context of a document. The `contextType` field distinguishes them.
 *
 * ALSO ABSORBS:
 *   AIAgents — Agent configuration is now embedded as `agentConfig` on
 *   the conversation. If you need org-level agent management, store it
 *   in Organization.features.aiAgents or a simple config doc.
 *
 * MIGRATION SOURCE:
 *   Old schemas: ChatHistory + FileChatHistory + DocumentStudio + AIAgents
 *
 * ============================================================================
 */

const mongoose = require("mongoose");
const { Schema, model } = mongoose;

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * A single message in the conversation.
 */
const messageSchema = new Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ["USER", "ASSISTANT", "SYSTEM"],
    },

    content: {
      type: String,
      required: true,
    },

    /** For assistant responses that include structured data */
    structuredContent: {
      type: Schema.Types.Mixed,
    },

    /** If the assistant generated a file/report */
    generatedFileUrl: { type: String },
    generatedFileName: { type: String },

    /** Token usage for this specific message exchange */
    inputTokens:  { type: Number },
    outputTokens: { type: Number },

    /** Is this message still streaming? */
    isStreaming: { type: Boolean, default: false },

    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const aiConversationSchema = new Schema(
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
    },

    // ------------------------------------------------------------------
    // Who started this conversation
    // ------------------------------------------------------------------

    identityId: {
      type: Schema.Types.ObjectId,
      ref: "Identity",
      required: true,
      index: true,
    },

    // ------------------------------------------------------------------
    // Conversation identity
    // ------------------------------------------------------------------

    /** User-visible title: "Q1 Fee Analysis", "Acme SPA Review" */
    title: {
      type: String,
      trim: true,
      maxlength: 300,
    },

    /**
     * What kind of conversation is this?
     *
     * GENERAL:    Open-ended AI chat (replaces ChatHistory)
     * DOCUMENT:   Chat about a specific uploaded document (replaces FileChatHistory)
     * STUDIO:     Document studio session — upload + parse + interactive Q&A (replaces DocumentStudio)
     * AGENT:      Agent-driven conversation (compliance, fee calc, etc.)
     */
    contextType: {
      type: String,
      required: true,
      enum: ["GENERAL", "DOCUMENT", "STUDIO", "AGENT"],
      default: "GENERAL",
    },

    // ------------------------------------------------------------------
    // Context — what is this conversation about?
    // ------------------------------------------------------------------

    /** Document being discussed (for DOCUMENT and STUDIO types) */
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },

    /**
     * For STUDIO: the uploaded document details.
     * Stored here because the studio session may involve a temp upload
     * that hasn't been classified as a Document yet.
     */
    studioDocument: {
      fileName:     { type: String },
      fileSize:     { type: Number },
      fileType:     { type: String },
      storageKey:   { type: String },
      storageUrl:   { type: String },
      uploadStatus: { type: String, enum: ["UPLOADING", "COMPLETED", "FAILED"] },
      uploadedAt:   { type: Date },
    },

    // ------------------------------------------------------------------
    // Agent config (absorbs AIAgents)
    // ------------------------------------------------------------------

    /**
     * Which AI agent/persona is handling this conversation.
     * Replaces the old AIAgents collection — agent config is now
     * inline since it's always used in the context of a conversation.
     */
    agentConfig: {
      agentName:    { type: String, trim: true },
      agentType:    { type: String, trim: true }, // "compliance", "accounting", "general"
      model:        { type: String, default: "claude-sonnet-4-20250514" },
      capabilities: [{ type: String }],
    },

    // ------------------------------------------------------------------
    // Messages
    // ------------------------------------------------------------------

    messages: [messageSchema],

    /** Total message count (for pagination without loading all messages) */
    messageCount: {
      type: Number,
      default: 0,
    },

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    status: {
      type: String,
      enum: ["ACTIVE", "ARCHIVED", "DELETED"],
      default: "ACTIVE",
    },

    lastMessageAt: {
      type: Date,
    },

    // ------------------------------------------------------------------
    // Extensibility
    // ------------------------------------------------------------------

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "aiconversations",

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

/** User's conversation list */
aiConversationSchema.index({ identityId: 1, status: 1, lastMessageAt: -1 });

/** Org-wide conversations */
aiConversationSchema.index({ organizationId: 1, contextType: 1, createdAt: -1 });

/** Document-linked conversations */
aiConversationSchema.index({ documentId: 1 }, { sparse: true });

/** Fund-specific conversations */
aiConversationSchema.index({ fundId: 1, createdAt: -1 });

module.exports = model("AiConversation", aiConversationSchema);
