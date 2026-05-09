# Firm Operations — LLM Reference (Layer 4B)

> Covers: Activity, BankConnection, BankTransaction

---

## How It All Fits Together

```
Organization (Firm Level)
├── Activities (workflow intake)
│   ├── ACT-2026-001: "Q1 Management Fee" (MANAGEMENT_FEE, COMPLETED)
│   │   └── → Fund I → Journal JE-2026-042
│   ├── ACT-2026-002: "Acme Corp Series A" (INVESTMENT, IN_REVIEW)
│   │   └── → Fund I → pending
│   └── ACT-2026-003: "March Bank Statement" (BANK_RECONCILIATION, ASSIGNED)
│       └── → unassigned fund → pending
│
├── BankConnections
│   ├── Mercury Checking ****4521 (ACTIVE, defaultFund: Fund I)
│   │   └── glAccountId → 1100 Cash
│   └── Chase Savings ****8877 (ACTIVE, Plaid)
│       └── glAccountId → 1110 Money Market
│
└── BankTransactions (from connected banks)
    ├── 2026-03-15: +$500,000 "Wire from LP Alice" (COMPLETE → JE-2026-039)
    ├── 2026-03-18: -$12,500 "Morgan Lewis Invoice" (IN_PROGRESS)
    └── 2026-03-20: -$200,000 "Wire to Acme Corp" (NOT_STARTED)
```

---

## Collection Quick Reference

| Collection | Key Fields | Primary Index |
|------------|-----------|---------------|
| `activities` | organizationId, fundId, activityType, title, status, assigneeId | { organizationId: 1, status: 1, createdAt: -1 } |
| `bankconnections` | organizationId, provider, bankName, accountNumberMask, status | { organizationId: 1, status: 1 } |
| `banktransactions` | bankConnectionId, transactionDate, amount, status, journalId | { bankConnectionId: 1, transactionDate: -1 } |

---

## Activity

### What It Is
The firm-level intake and workflow system. Every accounting event enters as an Activity, flows through triage → review → approval → journal generation. Think of it as a ticket system for fund accounting.

### Key Principle
Activity is a WORKFLOW CONTAINER. The domain-specific data lives in linked schemas (CapitalCall, Distribution, Investment, Valuation, etc.). Activity tracks: who created it, who it's assigned to, what type it is, where it is in the workflow, and what documents support it.

### Activity Types

| Type | Description | Typical Linked Schema |
|------|-------------|----------------------|
| CAPITAL_CALL | Capital call event | CapitalCall |
| DISTRIBUTION | Distribution event | Distribution |
| INVESTMENT | New or follow-on investment | Investment |
| EXIT | Full or partial exit | Investment (status update) |
| VALUATION | Fair value mark | Valuation |
| MANAGEMENT_FEE | Fee calculation & allocation | Journal (direct) |
| EXPENSE | Fund expense | Journal (direct) |
| INCOME | Interest, dividend, other | Journal (direct) |
| BANK_RECONCILIATION | Bank statement processing | BankTransaction(s) |
| INVESTOR_ONBOARDING | New LP setup | Investor |
| COMMITMENT_CHANGE | LP commitment change | Investor (commitment update) |
| PERIOD_CLOSE | Period-end checklist | AccountingPeriod |
| FX_REVALUATION | FX reval at period-end | Journal (direct) |
| CARRY_CALCULATION | Carried interest calc | Journal (direct) |
| JOURNAL_ENTRY | Manual journal entry | Journal (direct) |
| DOCUMENT_REVIEW | Doc needs classification | — |

### Status Lifecycle
```
DRAFT → PENDING_ASSIGNMENT → ASSIGNED → IN_REVIEW → PENDING_APPROVAL → APPROVED → COMPLETED
                                                   → REJECTED
                                                   → ON_HOLD
         → CANCELLED (from any state)
```

### The Intake Flow

1. **Document arrives** (invoice, bank statement, SPA, email)
2. **Activity auto-created** with `source: "DOCUMENT_UPLOAD"` and `status: "DRAFT"`
3. **AI processes** the document → sets `activityType`, suggests `fundId`, generates `aiSuggestion`
4. **Accountant triages** → assigns fund, confirms type, moves to `ASSIGNED`
5. **Review** → accountant builds journal, attaches to `draftJournalId`
6. **Approval** → GP/Admin approves, journal posts, Activity moves to `COMPLETED`

### Recurrence
For scheduled activities (quarterly management fees, annual carry calculations):
```javascript
activity.recurrence = {
  isRecurring: true,
  frequency: "QUARTERLY",
  nextDueDate: ISODate("2026-07-01"),
  parentActivityId: ObjectId("...template activity...")
}
```

### Common Queries

Dashboard — all open activities for an org:
```javascript
db.activities.find({
  organizationId: ObjectId("..."),
  status: { $nin: ["COMPLETED", "CANCELLED", "REJECTED"] }
}).sort({ priority: -1, dueDate: 1 })
```

Overdue items:
```javascript
db.activities.find({
  organizationId: ObjectId("..."),
  dueDate: { $lt: new Date() },
  status: { $nin: ["COMPLETED", "CANCELLED", "REJECTED"] }
})
```

Period-end checklist:
```javascript
db.activities.find({
  fundId: ObjectId("..."),
  fiscalQuarter: "Q1",
  fiscalYear: 2026,
  activityType: { $in: ["PERIOD_CLOSE", "FX_REVALUATION", "CARRY_CALCULATION", "VALUATION"] }
}).sort({ activityType: 1 })
```

### Migration: Old → New

| Old Activity Field | New Field | Notes |
|-------------------|-----------|-------|
| type (30+ free strings) | activityType (enum) | Map: "CAPITAL CALL"→CAPITAL_CALL, "DISTRIBUTION"→DISTRIBUTION, "NEW INVESTMENT"→INVESTMENT, "EXPENSE - PROFESSIONAL FEES"→EXPENSE, "BANK STATEMENT"→BANK_RECONCILIATION, etc. |
| entityId | organizationId | Via Entity→Organization lookup |
| fundId | fundId | Via FundInfo→Fund lookup |
| status | status | Map strings to enum |
| journalId | journalId | Direct |
| draftJournalId | draftJournalId | Direct |
| fileId | attachments[0].fileId | Restructure into array |
| cliComments[] | comments[] | Map: cliComments.comment→content, cliComments.approve→action:"APPROVE" |
| managementFeesData | metadata.legacyMgmtFeeData | Preserve in metadata, fee calc now lives in service layer |
| approvedBy | approvedBy | Direct |

---

## BankConnection

### What It Is
A connected bank account — via Plaid, Mercury, or manual CSV. Lives at ORGANIZATION level (firm-level). Transactions from this account get reconciled to specific funds.

### Key Principle
A bank account is a bank account regardless of how it's connected. The `provider` field distinguishes connection method. Each BankConnection maps to one GL cash account via `glAccountId`.

### Provider Support

| Provider | Connection Method | Credentials Stored |
|----------|------------------|-------------------|
| PLAID | Plaid Link flow | plaidAccessToken, plaidItemId, plaidAccountId |
| MERCURY | Mercury OAuth | mercuryAccessToken, mercuryRefreshToken, mercuryAccountId |
| MANUAL | CSV upload | — |

### GL Mapping
```javascript
bankConnection.glAccountId → ChartOfAccounts._id (e.g., account 1100 Cash)
```
When reconciling a BankTransaction from this connection, the system auto-fills the cash-side GL account.

### Sync Status
```javascript
// Check connections needing attention
db.bankconnections.find({
  organizationId: ObjectId("..."),
  $or: [
    { needsReconnection: true },
    { lastSyncStatus: "FAILED" }
  ]
})
```

### Sensitive Fields
ALL provider credentials are `select: false` — never included in queries unless explicitly requested. The `toJSON` transform strips `providerCredentials` and `rawProviderData` from API responses.

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| PlaidAccount | fundId | defaultFundId | Fund→Org context shift |
| PlaidAccount | plaidAccessToken | providerCredentials.plaidAccessToken | Direct |
| PlaidAccount | account_id | providerCredentials.plaidAccountId | Direct |
| PlaidAccount | bankName | bankName | Direct |
| PlaidAccount | accountName | accountName | Direct |
| PlaidAccount | routingNumber | routing.achRouting | Direct |
| PlaidAccount | wireRoutingNumber | routing.wireRouting | Direct |
| PlaidAccount | iban | routing.iban | Direct |
| PlaidAccount | bic | routing.swiftBic | Direct |
| PlaidAccount | sortCode | routing.sortCode | Direct |
| PlaidAccount | active | status: "ACTIVE" or "INACTIVE" | Map boolean→enum |
| PlaidAccount | needsReconnection | needsReconnection | Direct |
| MercuryAccount | mercuryAccountId | providerCredentials.mercuryAccountId | Direct |
| MercuryAccount | mercuryAccessToken | providerCredentials.mercuryAccessToken | Direct |
| MercuryAccount | mercuryRefreshToken | providerCredentials.mercuryRefreshToken | Direct |
| MercuryAccount | currentBalance | currentBalance | Cast to Decimal128 |
| MercuryAccount | availableBalance | availableBalance | Cast to Decimal128 |

---

## BankTransaction

### What It Is
A bank transaction from a connected bank account. This is RAW bank data that needs to be reconciled (matched) to journal entries. Positive amount = inflow (deposit), negative = outflow (payment).

### Key Principle
BankTransactions are the "bank side" of bank reconciliation. The "book side" is the GL cash account balance from JournalLines. Reconciling means matching a BankTransaction to a Journal.

### Reconciliation Flow
```
1. Transaction syncs from provider (or CSV upload)
2. System checks for duplicate (providerTransactionId unique index)
3. AI suggests journal entry → stored in aiSuggestion
4. Accountant reviews, assigns fund, picks GL accounts
5. Creates journal entry, links journalId
6. Status → COMPLETE, reconciledBy + reconciledAt set
```

### Status Values

| Status | Meaning |
|--------|---------|
| NOT_STARTED | New transaction, not yet reviewed |
| IN_PROGRESS | Being worked on (AI suggested, accountant reviewing) |
| COMPLETE | Matched to a journal entry |
| DUPLICATE | Duplicate transaction, skipped |
| EXCLUDED | Intentionally excluded from reconciliation |
| FAILED | Auto-reconciliation failed, needs manual review |

### Common Queries

Reconciliation queue (unreconciled transactions):
```javascript
db.banktransactions.find({
  organizationId: ObjectId("..."),
  status: { $in: ["NOT_STARTED", "IN_PROGRESS"] }
}).sort({ transactionDate: -1 })
```

Bank reconciliation at period-end:
```javascript
// Bank balance from transactions
db.banktransactions.aggregate([
  { $match: {
      bankConnectionId: ObjectId("..."),
      transactionDate: { $lte: ISODate("2026-03-31") },
      status: { $ne: "DUPLICATE" }
  }},
  { $group: {
      _id: null,
      bankBalance: { $sum: "$amount" }
  }}
])

// Compare with GL cash balance from JournalLines
// Difference = reconciling items (outstanding deposits, outstanding checks)
```

Reconciliation completion rate:
```javascript
db.banktransactions.aggregate([
  { $match: { bankConnectionId: ObjectId("...") }},
  { $group: {
      _id: "$status",
      count: { $sum: 1 }
  }}
])
```

### Deduplication
The unique index `{ bankConnectionId: 1, providerTransactionId: 1 }` prevents importing the same transaction twice. On sync, the system checks `providerTransactionId` before inserting.

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| BankFeedActivity | fundId | fundId | Direct (via Fund lookup) |
| BankFeedActivity | date | transactionDate | Direct |
| BankFeedActivity | debit | amount (negative) | Flip sign: old debit = outflow = negative |
| BankFeedActivity | credit | amount (positive) | Direct: credit = inflow = positive |
| BankFeedActivity | memo | description | Direct |
| BankFeedActivity | memoShort | descriptionShort | Direct |
| BankFeedActivity | balance | balance | Cast to Decimal128 |
| BankFeedActivity | transactionId | providerTransactionId | Direct |
| BankFeedActivity | journalId | journalId | Direct |
| BankFeedActivity | reconciledBy | reconciledBy | Map to Identity._id |
| BankFeedActivity | reconciledDate | reconciledAt | Direct |
| BankFeedActivity | status | status | Map: "NOT-STARTED"→NOT_STARTED, "IN-PROGRESS"→IN_PROGRESS |
| BankFeedActivity | preFillData | aiSuggestion | Direct (Mixed) |
| BankFeedActivity | isAiUpload | isAiProcessed | Direct |
| BankFeedActivity | plaidAccount | bankConnectionId | Via PlaidAccount→BankConnection lookup |
| BankFeedActivity | mercuryAccount | bankConnectionId | Via MercuryAccount→BankConnection lookup |
| PlaidBankFeed | * | rawData | Store full Plaid response in rawData |
| MercuryTransaction | * | rawData | Store full Mercury response in rawData |

---

## End-to-End: Document Intake to Posted Journal

Here's how a typical expense flows through the system:

```
1. GP uploads a legal invoice PDF
   → Activity created: type=EXPENSE, source=DOCUMENT_UPLOAD, status=DRAFT
   → AI reads PDF: amount=$15,000, vendor="Morgan Lewis", date=2026-03-15

2. AI suggests:
   activity.aiSuggestion = {
     journalType: "STANDARD",
     lines: [
       { accountCode: "5300", debit: 15000, description: "Legal - Morgan Lewis" },
       { accountCode: "2100", credit: 15000, description: "Accounts Payable" }
     ]
   }

3. Accountant reviews, assigns to Fund I, confirms → status=PENDING_APPROVAL

4. GP approves → status=APPROVED
   → System creates Journal (DRAFT → POSTED):
     DR  5300 Professional Fees - Legal    $15,000
     CR  2100 Accounts Payable             $15,000
   → Activity.journalId = journal._id
   → Activity.status = COMPLETED

5. When the wire goes out (from BankTransaction):
   → Another journal:
     DR  2100 Accounts Payable             $15,000
     CR  1100 Cash                         $15,000
   → BankTransaction.status = COMPLETE
```
