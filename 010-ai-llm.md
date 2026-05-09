# AI & LLM — LLM Reference (Layer 8)

> Covers: AiUsageLog, AiConversation
> Also covers absorbed schemas: AIAgents → AiConversation.agentConfig, ChatHistory → AiConversation, FileChatHistory → AiConversation, DocumentStudio → AiConversation

---

## Collection Quick Reference

| Collection | Model | Key Fields | Primary Index |
|------------|-------|-----------|---------------|
| `aiusagelogs` | AiUsageLog | organizationId, usageType, inputTokens, outputTokens, costUsd, model, status | { organizationId: 1, createdAt: -1 } |
| `aiconversations` | AiConversation | organizationId, identityId, contextType, documentId, messages[], status | { identityId: 1, status: 1, lastMessageAt: -1 } |

---

## AiUsageLog

### What It Is
Every AI/LLM API call gets logged here. Tracks tokens consumed, cost, duration, model, and what triggered the call. Used for billing, analytics, and debugging.

### Usage Types

| Type | What It Covers |
|------|---------------|
| CHAT | General AI chat |
| DOCUMENT_CHAT | Chat about a specific document |
| DOCUMENT_PARSE | AI document extraction/OCR |
| COMPLIANCE_CHECK | Compliance run AI calls |
| JOURNAL_ENTRY | AI-assisted journal creation |
| REPORT_GENERATION | AI report generation |
| RECONCILIATION | Bank reconciliation AI |
| WATERFALL_CALC | Waterfall calculation |
| FEE_CALCULATION | Management fee AI |
| CLASSIFICATION | Document classification |

### Common Queries

Monthly AI cost per org:
```javascript
db.aiusagelogs.aggregate([
  { $match: {
      organizationId: ObjectId("..."),
      status: "COMPLETED",
      createdAt: { $gte: ISODate("2026-01-01"), $lt: ISODate("2026-02-01") }
  }},
  { $group: {
      _id: "$usageType",
      totalTokens: { $sum: "$totalTokens" },
      totalCost: { $sum: "$costUsd" },
      callCount: { $sum: 1 },
      avgDurationMs: { $avg: "$durationMs" }
  }},
  { $sort: { totalCost: -1 } }
])
```

### Migration: Old → New

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| entityId | organizationId | Via Entity→Organization |
| type (snake_case strings) | usageType (UPPER_CASE enum) | Map: "ai_chat"→CHAT, "ai_upload"→DOCUMENT_PARSE, "ai_compliance"→COMPLIANCE_CHECK, "ai_journal_entry"→JOURNAL_ENTRY, "ai_report"→REPORT_GENERATION, "ai_reconciliation"→RECONCILIATION, "ai_waterfall"→WATERFALL_CALC, "ai_bank_rec"→RECONCILIATION, "ai_extraction"→DOCUMENT_PARSE, "skill_map"→CLASSIFICATION |
| price | costUsd | Cast to Decimal128 |
| triggeredBy → User | triggeredBy → Identity | Via User→Identity |
| referenceId + referenceModel | referenceId + referenceModel | Direct |

---

## AiConversation

### What It Is
A unified AI chat conversation. Replaces three old schemas (ChatHistory, FileChatHistory, DocumentStudio) with one collection. Every AI conversation — general Q&A, document-specific chat, or document studio sessions — lives here.

### Context Types

| Type | Replaces | When Used |
|------|----------|-----------|
| GENERAL | ChatHistory | Open-ended AI chat, no specific document |
| DOCUMENT | FileChatHistory | Chat about a specific document (linked via documentId) |
| STUDIO | DocumentStudio | Upload doc → parse → interactive Q&A session |
| AGENT | AIAgents | Agent-driven workflows (compliance, fee calc, etc.) |

### Message Structure
```javascript
conversation.messages = [
  {
    role: "USER",
    content: "What management fees did we charge LP Alice in Q1?",
    sentAt: ISODate("2026-04-01T10:00:00Z")
  },
  {
    role: "ASSISTANT",
    content: "LP Alice was charged $5,000 in management fees for Q1 2026...",
    structuredContent: {
      type: "fee_breakdown",
      data: { basis: 1000000, rate: 0.02, quarterly: 5000 }
    },
    inputTokens: 1250,
    outputTokens: 340,
    sentAt: ISODate("2026-04-01T10:00:02Z")
  }
]
```

### Studio Sessions
For STUDIO type, the uploaded document details are stored inline:
```javascript
conversation.studioDocument = {
  fileName: "Acme_SPA_SeriesA.pdf",
  fileSize: 2456789,
  fileType: "PDF",
  storageKey: "studio/abc-123/Acme_SPA.pdf",
  storageUrl: "https://...",
  uploadStatus: "COMPLETED",
  uploadedAt: ISODate("2026-04-01")
}
```
Once the user saves/classifies the document, a Document record is created and `documentId` is set.

### Agent Config (absorbs AIAgents)
```javascript
conversation.agentConfig = {
  agentName: "BlueCheck Compliance",
  agentType: "compliance",
  model: "claude-sonnet-4-20250514",
  capabilities: ["asc946_check", "lpa_covenant_review", "fee_validation"]
}
```
The old AIAgents collection stored agent definitions at the org level. In the new design, the agent config is captured per-conversation. If you need org-level agent templates, store them in `Organization.features.aiAgents` or a config file.

### Common Queries

User's recent conversations:
```javascript
db.aiconversations.find({
  identityId: ObjectId("..."),
  status: "ACTIVE"
}).sort({ lastMessageAt: -1 }).limit(20)
```

All document chats for a file:
```javascript
db.aiconversations.find({
  documentId: ObjectId("..."),
  contextType: { $in: ["DOCUMENT", "STUDIO"] }
})
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| ChatHistory | entityId | organizationId | Via Entity→Organization |
| ChatHistory | roleId → Role | identityId → Identity | Via Role→Identity |
| ChatHistory | question | messages[].content (role: USER) | Restructure into message array |
| ChatHistory | answer | messages[].content (role: ASSISTANT) | Restructure into message array |
| ChatHistory | answerArray | messages[].structuredContent | Direct (Mixed) |
| ChatHistory | historyMessage | — | Absorbed into messages[] array |
| ChatHistory | agentId | agentConfig | Inline agent config |
| ChatHistory | downloadUrl | messages[].generatedFileUrl | Per-message |
| ChatHistory | — | contextType: "GENERAL" | Set for all ChatHistory records |
| FileChatHistory | fileId → DocumentRoom | documentId → Document | Via DocumentRoom→Document |
| FileChatHistory | — | contextType: "DOCUMENT" | Set for all FileChatHistory records |
| DocumentStudio | sessionId | _id (use as conversation ID) | Or store in metadata |
| DocumentStudio | sessionName | title | Direct |
| DocumentStudio | document.* | studioDocument.* | Map: fileName, fileSize, fileType, s3Key→storageKey, s3Url→storageUrl |
| DocumentStudio | messages[] | messages[] | Map: role lowercase→uppercase, content→content |
| DocumentStudio | aiRequests[] | — | Token tracking → AiUsageLog records |
| DocumentStudio | — | contextType: "STUDIO" | Set for all DocumentStudio records |
| AIAgents | name | agentConfig.agentName | Inline on conversations that used this agent |
| AIAgents | capabilities[].name | agentConfig.capabilities[] | Flatten to string array |
| AIAgents | status | — | Active agents are simply used; inactive ones aren't |
