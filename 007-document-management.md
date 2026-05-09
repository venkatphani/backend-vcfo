# Document Management — LLM Reference (Layer 5)

> Covers: Document, Folder, DocumentAccessLog

---

## How It All Fits Together

```
Organization
├── Fund I
│   ├── Folder tree (predefined + custom)
│   │   ├── Portfolio/                    (PORTFOLIO, isSystem: true)
│   │   │   ├── Acme Corp/               (PORTFOLIO_COMPANY, investmentId: acme)
│   │   │   │   └── Acme_SPA_SeriesA.pdf (Document, category: INVESTMENT)
│   │   │   └── Beta Inc/                (PORTFOLIO_COMPANY, investmentId: beta)
│   │   ├── Investors/                    (INVESTORS, isSystem: true)
│   │   │   ├── Common/                   (INVESTORS_COMMON, isCommon: true)
│   │   │   │   └── Q1_Report.pdf         (Document, category: REPORT, visibility: INVESTORS)
│   │   │   ├── Alice Smith/              (INVESTOR_INDIVIDUAL, investorId: alice)
│   │   │   │   ├── Subscription_Agreement.pdf  (category: INVESTOR, eSign.isSigned: true)
│   │   │   │   └── W9_2026.pdf                 (category: TAX, investorId: alice)
│   │   │   └── Bob Jones/               (INVESTOR_INDIVIDUAL, investorId: bob)
│   │   ├── Accounting/                   (ACCOUNTING, isSystem: true)
│   │   │   ├── Journals/                 (JOURNALS)
│   │   │   │   └── Invoice_MorganLewis.pdf     (category: INVOICE, journalId: je-042)
│   │   │   └── Bank Statements/          (BANK_STATEMENTS)
│   │   ├── Capital Calls/                (CAPITAL_CALLS, isSystem: true)
│   │   │   └── CC-2026-001_Notice.pdf    (category: CAPITAL_CALL, capitalCallId: cc-001)
│   │   ├── Distributions/                (DISTRIBUTIONS, isSystem: true)
│   │   ├── Tax/                          (TAX, isSystem: true)
│   │   │   ├── K-1s/                     (K1S)
│   │   │   └── 1065/                     (TAX_1065)
│   │   └── Reports/                      (REPORTS, isSystem: true)
│   │
│   └── DocumentAccessLogs
│       ├── Alice viewed Q1_Report.pdf at 2026-04-01 (source: LP_PORTAL)
│       └── Bob downloaded K1_2025.pdf at 2026-03-15 (source: LP_PORTAL)
```

---

## Collection Quick Reference

| Collection | Model | Key Fields | Primary Index |
|------------|-------|-----------|---------------|
| `documents` | Document | organizationId, fundId, originalName, category, folderId, processingStatus | { fundId: 1, category: 1, isDeleted: 1 } |
| `folders` | Folder | organizationId, fundId, folderName, folderType, parentFolderId, isSystem | { fundId: 1, isDeleted: 1, folderType: 1 } |
| `documentaccesslogs` | DocumentAccessLog | documentId, accessedBy, action, accessedAt | { documentId: 1, accessedAt: -1 } |

---

## Document

### What It Is
A file stored in the system — invoices, SPAs, bank statements, tax forms, signed docs, reports. Replaces old File, DocumentRoom, and JournalDocument with a single collection.

### Key Design Decisions

**One collection, not three.** Old system had File (raw uploads), DocumentRoom (classified docs with 15+ boolean flags), and JournalDocument (journal↔doc links). New design: every upload is a Document. Classification is via `category` enum. Journal linking is via `journalId` ref.

**Category enum, not boolean flags.** Old: `isCapitalCall: true, isDistribution: false, isPartner: false, isAccounting: false...` New: `category: "CAPITAL_CALL"`. Adding a new doc type = adding an enum value, not a schema migration.

**Processing pipeline.** Documents flow through: UPLOADED → PROCESSING (AI parsing) → CLASSIFIED (AI done, human review) → ACTIVE (confirmed). This replaces the old `fileType: STAGING → DIRECT` pattern.

### Category Enum

| Category | What Goes Here | Typical Entity Link |
|----------|---------------|-------------------|
| CAPITAL_CALL | Call notices, wire instructions | capitalCallId |
| DISTRIBUTION | Distribution notices | distributionId |
| INVESTMENT | SPAs, term sheets, closing docs | investmentId |
| VALUATION | Valuation reports | valuationId |
| INVESTOR | Subscription agreements, side letters | investorId |
| ONBOARDING | KYC docs, ID verification | investorId |
| TAX | W-9, W-8BEN, K-1 | investorId |
| ACCOUNTING | Journal support, working papers | journalId |
| INVOICE | Vendor invoices | journalId or activityId |
| BANK_STATEMENT | Bank statements | activityId |
| LEGAL | LPA, amendments | — |
| SIGNED | E-signed documents | investorId |
| REPORT | Generated reports | — |
| GENERAL | Uncategorized | — |

### Processing Pipeline

```
UPLOADED → PROCESSING → CLASSIFIED → ACTIVE
                                   → DUPLICATE (linked via duplicateOfId)
                     → FAILED
                                              → ARCHIVED (soft archive)
```

### E-Signature Tracking
```javascript
document.eSign = {
  isSigned: true,
  provider: "SIGNNOW",
  providerDocId: "sn-abc-123",
  signedAt: ISODate("2026-03-15"),
  approvalStatus: "APPROVED",
  approvedBy: ObjectId("..."),
  approvedAt: ISODate("2026-03-16")
}
```

### Versioning
Documents support multiple versions (file replacement without losing history):
```javascript
document.currentVersion = 2;
document.versions = [
  { versionNumber: 1, storageKey: "docs/old-v1.pdf", uploadedBy: "...", uploadedAt: "..." },
  { versionNumber: 2, storageKey: "docs/current-v2.pdf", uploadedBy: "...", uploadedAt: "..." },
]
```

### Common Queries

Find all documents supporting a journal entry:
```javascript
db.documents.find({ journalId: ObjectId("..."), isDeleted: false })
```

Find all docs for an investor:
```javascript
db.documents.find({ investorId: ObjectId("..."), isDeleted: false })
  .sort({ category: 1, createdAt: -1 })
```

Find unprocessed documents (AI queue):
```javascript
db.documents.find({
  organizationId: ObjectId("..."),
  processingStatus: { $in: ["UPLOADED", "PROCESSING"] }
})
```

Documents in a folder:
```javascript
db.documents.find({ folderId: ObjectId("..."), isDeleted: false })
  .sort({ createdAt: -1 })
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| DocumentRoom | fundId | fundId | Via Fund lookup |
| DocumentRoom | entityId | organizationId | Via Entity→Organization |
| DocumentRoom | roleId | uploadedBy | Map Role→Identity |
| DocumentRoom | folderId | folderId | Direct |
| DocumentRoom | originalName | originalName | Direct |
| DocumentRoom | fileName | storageKey | Direct |
| DocumentRoom | url | storageUrl | Direct |
| DocumentRoom | size | fileSize | Direct |
| DocumentRoom | type | mimeType | Direct |
| DocumentRoom | isCapitalCall | category: "CAPITAL_CALL" | Boolean → enum |
| DocumentRoom | isDistribution | category: "DISTRIBUTION" | Boolean → enum |
| DocumentRoom | isPartner | category: "INVESTOR" | Boolean → enum |
| DocumentRoom | isAccounting | category: "ACCOUNTING" | Boolean → enum |
| DocumentRoom | isInvestment | category: "INVESTMENT" | Boolean → enum |
| DocumentRoom | isInvoice | category: "INVOICE" | Boolean → enum |
| DocumentRoom | isSignedDocument | eSign.isSigned: true | Boolean → sub-doc |
| DocumentRoom | isOnboarding | category: "ONBOARDING" | Boolean → enum |
| DocumentRoom | fileType (STAGING/DIRECT) | processingStatus | Map: STAGING→UPLOADED, DIRECT→ACTIVE, DUPLICATE→DUPLICATE, FAILED→FAILED |
| DocumentRoom | approvalStatus | eSign.approvalStatus | Direct |
| DocumentRoom | accessTo[] | permissions[] | Map userId→identityId, accessType→accessLevel |
| DocumentRoom | journalId | journalId | Direct |
| DocumentRoom | partnerId | investorId | Via FundCapitalInfo→Investor |
| DocumentRoom | documentPortfolioId | investmentId | Via FundPortCoInfo→Investment |
| DocumentRoom | isFavorite | isFavorite | Direct |
| DocumentRoom | isDeleted | isDeleted | Direct |
| DocumentRoom | recentlyOpen | lastAccessedAt | Direct |
| File | entityId | organizationId | Via Entity→Organization |
| File | originalName | originalName | Direct |
| File | url | storageUrl | Direct |
| File | size | fileSize | Direct |
| File | type | mimeType | Direct |
| File | status | processingStatus | Map statuses |
| JournalDocument | journalId | journalId | Direct (now a field on Document) |
| JournalDocument | documentId | — | This IS the Document record now |
| JournalDocument | name | originalName | Direct |

---

## Folder

### What It Is
A folder in the document hierarchy. Supports nesting via parentFolderId. Predefined system folders use `folderType` enum instead of 20+ boolean flags.

### System Folder Creation
When a new fund is created, call this to generate the predefined folder tree:
```javascript
const PREDEFINED_TREE = [
  { folderType: "PORTFOLIO", folderName: "Portfolio" },
  { folderType: "INVESTORS", folderName: "Investors", children: [
    { folderType: "INVESTORS_COMMON", folderName: "Common", isCommon: true },
  ]},
  { folderType: "ACCOUNTING", folderName: "Accounting", children: [
    { folderType: "JOURNALS", folderName: "Journals" },
    { folderType: "BANK_STATEMENTS", folderName: "Bank Statements" },
  ]},
  { folderType: "CAPITAL_CALLS", folderName: "Capital Calls" },
  { folderType: "DISTRIBUTIONS", folderName: "Distributions" },
  { folderType: "TAX", folderName: "Tax", children: [
    { folderType: "K1S", folderName: "K-1s" },
    { folderType: "TAX_1065", folderName: "1065" },
  ]},
  { folderType: "REPORTS", folderName: "Reports", children: [
    { folderType: "REPORT_TEMPLATES", folderName: "Templates" },
  ]},
  { folderType: "FORMATION", folderName: "Formation Docs" },
  { folderType: "FINANCIALS", folderName: "Financials" },
  { folderType: "ESIGN", folderName: "E-Sign" },
  { folderType: "GENERAL", folderName: "General" },
];
```

### Auto-Filing Rules
When a document is uploaded/classified, auto-file to the correct folder:
```
category: "CAPITAL_CALL"  → find folder WHERE folderType = "CAPITAL_CALLS" AND fundId = doc.fundId
category: "TAX"           → find folder WHERE folderType = "TAX" (or K1S for K-1s)
category: "INVESTOR"      → find folder WHERE folderType = "INVESTOR_INDIVIDUAL" AND investorId = doc.investorId
category: "ACCOUNTING"    → find folder WHERE folderType = "JOURNALS" (if journalId set)
category: "INVOICE"       → find folder WHERE folderType = "ACCOUNTING"
```

### Migration: Old Boolean Flags → New Enum

| Old Boolean | New folderType |
|-------------|---------------|
| isPortfolioPreDefined | PORTFOLIO |
| isInvestorsPreDefined | INVESTORS |
| isAccountingPreDefined | ACCOUNTING |
| isCapitalCallsPreDefined | CAPITAL_CALLS |
| isDistributionPreDefined | DISTRIBUTIONS |
| isReportsPreDefined | REPORTS |
| isFormationDocsPreDefined | FORMATION |
| isK1sPreDefined | K1S |
| isTaxesPreDefined | TAX |
| isFinancialsPreDefined | FINANCIALS |
| isCashPreDefined | CASH |
| isGeneralPreDefined | GENERAL |
| isESignProfilePreDefined | ESIGN |
| isJournalsPreDefined | JOURNALS |
| isAuditReportsPredefined | AUDIT_REPORTS |
| is1065ReportsPredefined | TAX_1065 |
| isReportTemplatesPredefined | REPORT_TEMPLATES |
| isLineofCreditPreDefined | LINE_OF_CREDIT |
| isIncomeAndExpensesPreDefined | INCOME_EXPENSES |
| isPreDefined (any) | isSystem: true |

---

## DocumentAccessLog

### What It Is
Immutable append-only log of every document view and download. Separate from AuditTrail because read access is high-frequency and doesn't represent a data change.

### Common Queries

Who accessed a document:
```javascript
db.documentaccesslogs.find({ documentId: ObjectId("...") })
  .sort({ accessedAt: -1 })
```

All downloads by a person:
```javascript
db.documentaccesslogs.find({ accessedBy: ObjectId("..."), action: "DOWNLOAD" })
  .sort({ accessedAt: -1 })
```

LP portal access report (compliance):
```javascript
db.documentaccesslogs.aggregate([
  { $match: {
      fundId: ObjectId("..."),
      source: "LP_PORTAL",
      accessedAt: { $gte: ISODate("2026-01-01"), $lt: ISODate("2026-04-01") }
  }},
  { $group: {
      _id: "$accessedBy",
      totalViews: { $sum: { $cond: [{ $eq: ["$action", "VIEW"] }, 1, 0] } },
      totalDownloads: { $sum: { $cond: [{ $eq: ["$action", "DOWNLOAD"] }, 1, 0] } },
      lastAccess: { $max: "$accessedAt" }
  }}
])
```

### Migration: Old → New

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| documentId → DocumentRoom | documentId → Document | Remap IDs |
| roleId | — | Removed (use accessedBy → Identity) |
| accessedBy → User | accessedBy → Identity | Via User→Identity |
| entityId → Entity | organizationId → Organization | Via Entity→Organization |
| fundId | fundId | Via FundInfo→Fund |
| action ("view"/"download") | action ("VIEW"/"DOWNLOAD") | Uppercase enum |
| documentName | documentName | Direct |
| source | source | Direct |

---

## LpDashboardData → Absorbed into Document

### What It Was
The old LpDashboardData was a separate record created when a document was uploaded and AI-parsed. It stored the parsed/extracted data alongside classification info. Each LpDashboardData linked to a DocumentRoom record via `fileId`.

### Why It's Absorbed
In the new design, Document already has `aiExtractedData` (Mixed), `processingStatus` (pipeline), and `category` + `documentType` (classification). There's no need for a separate collection to track what was parsed from a file — the parsing results live on the Document itself.

### Migration: Old → New

| Old LpDashboardData Field | New Document Field | Notes |
|---------------------------|-------------------|-------|
| fileId → DocumentRoom | — (this IS the Document record now) | Merge into Document by fileId |
| entityId | organizationId | Via Entity→Organization |
| type (45+ enum) | category + documentType | Map: "Capital Statements"→ACCOUNTING, "Capital Call Notices"→CAPITAL_CALL, "Distribution Notices"→DISTRIBUTION, "K1s"→TAX, "Sub Docs"→INVESTOR, "LPA"→LEGAL, "Side Letter"→INVESTOR, "W-9"/"W-8BEN"/"W-8BEN-E"→TAX, "Bank Statement"→BANK_STATEMENT, "Term Sheet"→INVESTMENT, "Schedule Of Investments"→REPORT. Use documentType for the granular old type string. |
| data | aiExtractedData | Direct (both are Mixed) |
| parsedData | aiExtractedData | Merge with data into single field |
| miscData | metadata | Direct |
| status | processingStatus | Map: "NOT-STARTED"→UPLOADED, "IN-PROGRESS"→PROCESSING, "COMPLETE"→ACTIVE, "FAILED"→FAILED, "DUPLICATE"→DUPLICATE |
| fileName | originalName | Direct |
| fundName | aiExtractedData.fundName | Extracted metadata |
| partnerName | aiExtractedData.partnerName | Extracted metadata |
| quarter | aiExtractedData.quarter | Extracted metadata |
| platform | metadata.platform | Source platform |

### Type Mapping (45+ old types → new category enum)

| Old Type | New category | New documentType |
|----------|-------------|-----------------|
| Capital Statements | ACCOUNTING | "Capital Statement" |
| Capital Call Notices | CAPITAL_CALL | "Call Notice" |
| Distribution Notices | DISTRIBUTION | "Distribution Notice" |
| Sub Docs | INVESTOR | "Subscription Document" |
| LPA | LEGAL | "LPA" |
| LPA Amendment | LEGAL | "LPA Amendment" |
| Side Letter | INVESTOR | "Side Letter" |
| K1s | TAX | "K-1" |
| W-9 | TAX | "W-9" |
| W-8BEN / W-8BEN-E | TAX | "W-8BEN" / "W-8BEN-E" |
| Fund Reports | REPORT | "Fund Report" |
| Schedule Of Investments | REPORT | "Schedule of Investments" |
| Bank Statement | BANK_STATEMENT | "Bank Statement" |
| Investment | INVESTMENT | "Investment Document" |
| Term Sheet | INVESTMENT | "Term Sheet" |
| Expense | INVOICE | "Expense" |
| Journals | ACCOUNTING | "Journal" |
| PPM | LEGAL | "PPM" |
| Wire Instructions | ACCOUNTING | "Wire Instructions" |
| Balance Sheet / Income Statement / Cash Flow Statement | REPORT | (keep as documentType) |
| Cap Table / Board Deck / KPI | REPORT | (keep as documentType) |
| Email | GENERAL | "Email" |
| Template | TEMPLATE | "Template" |
| Other / unclassified | GENERAL | "Other" |
| duplicate | processingStatus: DUPLICATE | — |
