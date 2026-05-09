# VCFO Schema — Master Index

> **Version**: 2.0 (complete)
> **Database**: MongoDB 6+ with multi-document transactions
> **Accounting Standard**: US GAAP ASC 946 (Investment Companies)
> **Target Users**: VC/PE firms, fund administrators, family offices

---

## 8 Golden Rules

These rules are inviolable across the entire schema. Every LLM operation, API endpoint, and UI must respect them.

1. **Decimal128 everywhere** — All monetary amounts use `Schema.Types.Decimal128`, never `Number` or `Double`. No floating-point arithmetic on money.

2. **Double-entry always balances** — `SUM(functionalDebit) == SUM(functionalCredit)` on every posted Journal. The system must reject any journal where debits ≠ credits.

3. **Period locking is law** — No journal can be posted to a `HARD_CLOSED` period. Only `ADJUSTING` or `CLOSING` journal types can post to `SOFT_CLOSED` periods.

4. **Audit everything** — Every CREATE, UPDATE, DELETE writes to AuditTrail via middleware. No exceptions. Sensitive fields are auto-redacted.

5. **Tenant isolation** — Every query must include `organizationId`. Cross-org queries are never allowed at the application layer.

6. **Balances are derived, never stored** — Account balances, capital account balances, and NAV are computed by aggregating JournalLines. Never store a running balance on a document.

7. **3-amount FX on every line** — Every JournalLine carries transaction, functional, and reporting amounts. Single-currency funds set all three equal.

8. **Dimensions enforce context** — If a ChartOfAccounts record has `requiresInvestor: true`, every JournalLine hitting that account MUST have `investorId` set. Same for `requiresInvestment`.

---

## Complete Collection Inventory (19 collections)

### Layer 1 — Root (tenant foundation)

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 1 | `organizations` | Organization | [001](001-organization.md) | Firm/tenant root. Address, billing, features, fiscal year, base currency. |
| 2 | `identities` | Identity | [002](002-identity-and-org-member.md) | Auth-only user record. Email, password hash, 2FA. No business data. |
| 3 | `organizationmembers` | OrganizationMember | [002](002-identity-and-org-member.md) | Join table: Identity ↔ Organization with role and permissions. |
| 4 | `audittrails` | AuditTrail | [003](003-audit-trail.md) | Immutable append-only log of every data change. |

### Layer 2 — Fund Structure

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 5 | `funds` | Fund | [004](004-accounting-engine.md) | Individual fund/SPV/vehicle. Economics, timeline, lifecycle. |
| 6 | `fundroles` | FundRole | [004](004-accounting-engine.md) | Identity ↔ Fund permissions (FUND_MANAGER, ACCOUNTANT, etc.). |

### Layer 3 — Accounting Engine

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 7 | `chartofaccounts` | ChartOfAccounts | [004](004-accounting-engine.md) | GL accounts per fund. Hierarchical, two-level classification. |
| 8 | `accountingperiods` | AccountingPeriod | [004](004-accounting-engine.md) | Fiscal periods with OPEN/SOFT_CLOSED/HARD_CLOSED locking. |
| 9 | `fxrates` | FxRate | [004](004-accounting-engine.md) | Exchange rate library (SPOT, PERIOD_END, PERIOD_AVG, HISTORICAL). |
| 10 | `journals` | Journal | [004](004-accounting-engine.md) | Journal entry header. Lifecycle: DRAFT→PENDING_APPROVAL→POSTED→REVERSED. |
| 11 | `journallines` | JournalLine | [004](004-accounting-engine.md) | Double-entry lines. 3-amount FX. Dimensional tags (investorId, investmentId). |

### Layer 4A — Fund Operations

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 12 | `investors` | Investor | [005](005-fund-operations.md) | LP/GP investor per fund. Commitment, fee terms, banking, tax, KYC. |
| 13 | `investments` | Investment | [005](005-fund-operations.md) | Portfolio company/asset. Instrument terms, cost basis, exit tracking. |
| 14 | `valuations` | Valuation | [005](005-fund-operations.md) | Fair value marks per investment per date. ASC 820 methodology. |
| 15 | `capitalcalls` | CapitalCall | [005](005-fund-operations.md) | Capital call events with per-LP allocation breakdown. |
| 16 | `distributions` | Distribution | [005](005-fund-operations.md) | Distribution events with per-LP allocation and character breakdown. |

### Layer 4B — Firm Operations

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 17 | `activities` | Activity | [006](006-firm-operations.md) | Firm-level workflow/task manager. Intake → review → approval → journal. |
| 18 | `bankconnections` | BankConnection | [006](006-firm-operations.md) | Unified bank account connections (Plaid, Mercury, manual). |
| 19 | `banktransactions` | BankTransaction | [006](006-firm-operations.md) | Bank feed transactions for reconciliation. |

### Layer 5 — Document Management

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 20 | `documents` | Document | [007](007-document-management.md) | Unified file/document storage. Replaces File + DocumentRoom + JournalDocument. |
| 21 | `folders` | Folder | [007](007-document-management.md) | Document folder hierarchy. Predefined + custom folders. |
| 22 | `documentaccesslogs` | DocumentAccessLog | [007](007-document-management.md) | Immutable log of document views and downloads. |

### Layer 6 — Management Fees & Job Queue

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 23 | `managementfeecalcs` | ManagementFeeCalc | [008](008-management-fees.md) | Per-LP per-quarter fee calculation results. |
| 24 | `jobqueue` | JobQueue | [008](008-management-fees.md) | Generic async job queue for long-running operations. |

### Layer 7 — Platform & Admin

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 25 | `dealpipeline` | DealPipeline | [009](009-platform-admin.md) | Deal pipeline / investment CRM. Pre-investment tracking. |
| 26 | `complianceruns` | ComplianceRun | [009](009-platform-admin.md) | AI-powered compliance check results. |
| 27 | `investmentrights` | InvestmentRight | [009](009-platform-admin.md) | Legal rights extracted from investment documents. |

### Layer 8 — AI & LLM

| # | Collection | Model Name | Doc | Purpose |
|---|-----------|------------|-----|---------|
| 28 | `aiusagelogs` | AiUsageLog | [010](010-ai-llm.md) | AI/LLM token and cost tracking per operation. |
| 29 | `aiconversations` | AiConversation | [010](010-ai-llm.md) | Unified AI chat conversations (general, document, studio, agent). |

### Cross-Cutting

| File | Purpose |
|------|---------|
| `middleware/auditMiddleware.js` | Drop-in audit logging for any schema. Pre/post hooks, diff computation, redaction. |

---

## Reference ID Chain

For any document, here's how to trace its full context:

```
JournalLine._id
  → journalId      → Journal (header, status, type)
  → accountId      → ChartOfAccounts (account name, class, normal balance)
  → investorId     → Investor (LP name, commitment, fee terms)
  → investmentId   → Investment (company name, instrument type, cost basis)
  → fundId         → Fund (fund name, currency, economics)
  → periodId       → AccountingPeriod (period code, lock status)

Journal._id
  → sourceDocumentId → CapitalCall / Distribution / Activity (what triggered this entry)
  → fundId           → Fund → organizationId → Organization

Investor._id
  → identityId       → Identity (login, email)
  → organizationMemberId → OrganizationMember (org-level role)
  → fundId            → Fund

Activity._id
  → linkedCapitalCallId  → CapitalCall → Journal → JournalLines
  → linkedDistributionId → Distribution → Journal → JournalLines
  → linkedInvestmentId   → Investment → Valuations
  → journalId            → Journal → JournalLines

BankTransaction._id
  → bankConnectionId → BankConnection (bank name, provider, GL account)
  → journalId        → Journal (once reconciled)
  → activityId       → Activity (workflow context)

Document._id
  → folderId         → Folder (folder location, folderType)
  → journalId        → Journal (supporting document for this entry)
  → investorId       → Investor (subscription doc, tax form)
  → investmentId     → Investment (SPA, term sheet)
  → capitalCallId    → CapitalCall (call notice)
  → distributionId   → Distribution (distribution notice)
  → activityId       → Activity (workflow that produced/consumed this doc)
```

---

## Migration Lookup Chain

How old schemas map to new ones:

| Old Collection | New Collection(s) | Migration Doc |
|---------------|-------------------|---------------|
| Entity | Organization + Fund | [001](../migration/001-entity-to-organization.md), [004](004-accounting-engine.md) |
| User | Identity | [002](002-identity-and-org-member.md) |
| Role | OrganizationMember + FundRole + Investor | [002](002-identity-and-org-member.md), [005](005-fund-operations.md) |
| FundInfo | Fund | [004](004-accounting-engine.md) |
| AccountMapping | ChartOfAccounts | [004](004-accounting-engine.md) |
| JournalEntry | Journal | [004](004-accounting-engine.md) |
| JournalLedger | JournalLine | [004](004-accounting-engine.md) |
| FundPortCoInfo | Investment | [005](005-fund-operations.md) |
| FundPortCoInvestmentInfo | Investment (terms + exit) | [005](005-fund-operations.md) |
| FundCapitalInfo | Investor (commitment fields) | [005](005-fund-operations.md) |
| FundCapitalCall | CapitalCall | [005](005-fund-operations.md) |
| FundCapitalDistribution | Distribution | [005](005-fund-operations.md) |
| Transaction | CapitalCall.allocations[] + Distribution.allocations[] | [005](005-fund-operations.md) |
| CommitmentHistory | Investor.commitmentHistory[] (embedded) | [005](005-fund-operations.md) |
| PlaidAccount | BankConnection (provider: PLAID) | [006](006-firm-operations.md) |
| MercuryAccount | BankConnection (provider: MERCURY) | [006](006-firm-operations.md) |
| BankFeedActivity | BankTransaction | [006](006-firm-operations.md) |
| PlaidBankFeed | BankTransaction.rawData | [006](006-firm-operations.md) |
| MercuryTransaction | BankTransaction.rawData | [006](006-firm-operations.md) |
| PlaidKycData | Investor.kyc (embedded) | [005](005-fund-operations.md) |
| Activity | Activity (redesigned) | [006](006-firm-operations.md) |
| AuditLog | AuditTrail | [003](003-audit-trail.md) |
| File | Document | [007](007-document-management.md) |
| DocumentRoom | Document | [007](007-document-management.md) |
| JournalDocument | Document.journalId (field, not separate collection) | [007](007-document-management.md) |
| Folder | Folder (redesigned — booleans → enum) | [007](007-document-management.md) |
| DocumentAccessLog | DocumentAccessLog (minor ref updates) | [007](007-document-management.md) |
| LpDashboardData | Document (aiExtractedData + processingStatus) | [007](007-document-management.md) |
| ManagementFeeQuarterly | ManagementFeeCalc | [008](008-management-fees.md) |
| ManagementFeesFundCapital | ManagementFeeCalc (superseded) | [008](008-management-fees.md) |
| ManagementFeeSchedule | Investor.feeTerms + ManagementFeeCalc.formulaSnapshot | [008](008-management-fees.md) |
| ManagementFeeExport | Document (category: REPORT) | [008](008-management-fees.md) |
| ManagementFeeQueue | JobQueue (jobType: MANAGEMENT_FEE_CALC) | [008](008-management-fees.md) |
| DealTracker | DealPipeline | [009](009-platform-admin.md) |
| ComplianceRun | ComplianceRun (redesigned) | [009](009-platform-admin.md) |
| FavoriteRights | InvestmentRight | [009](009-platform-admin.md) |
| AdminControl | Investor.portalAccess (embedded) | [009](009-platform-admin.md) |
| Grouping | Organization + Fund.fundFamily (absorbed) | [009](009-platform-admin.md) |
| TemplateReport | Document (category: REPORT) | [009](009-platform-admin.md) |
| AiUsageLog | AiUsageLog (redesigned) | [010](010-ai-llm.md) |
| ChatHistory | AiConversation (contextType: GENERAL) | [010](010-ai-llm.md) |
| FileChatHistory | AiConversation (contextType: DOCUMENT) | [010](010-ai-llm.md) |
| DocumentStudio | AiConversation (contextType: STUDIO) | [010](010-ai-llm.md) |
| AIAgents | AiConversation.agentConfig (embedded) | [010](010-ai-llm.md) |
| Notification | — (moved to application layer) | — |
| FeedbackAndSupport | — (moved to application layer) | — |

---

## Financial Statement → Query Mapping

### Balance Sheet (Statement of Assets and Liabilities)
```
ASSETS
  Cash and cash equivalents         → CoA where accountSubClass = "CASH"
  Investments at fair value          → CoA where accountSubClass starts with "INVESTMENT"
  Capital call receivable            → CoA where accountSubClass = "CAPITAL_CALL_RECEIVABLE"
  Interest/dividends receivable      → CoA where accountSubClass = "INTEREST_RECEIVABLE"
  Other assets                       → CoA where accountClass = "ASSET" and not above

LIABILITIES
  Accounts payable                   → CoA where accountSubClass = "ACCOUNTS_PAYABLE"
  Management fee payable             → CoA where accountSubClass = "MANAGEMENT_FEE_PAYABLE"
  Carried interest payable           → CoA where accountSubClass = "CARRIED_INTEREST_PAYABLE"
  Other liabilities                  → CoA where accountClass = "LIABILITY" and not above

NET ASSETS (PARTNERS' CAPITAL)       → Total Assets - Total Liabilities
  = SUM of all Investor capital accounts
```

### Statement of Operations
```
INVESTMENT INCOME
  Interest income                    → CoA accountSubClass = "INTEREST_INCOME"
  Dividend income                    → CoA accountSubClass = "DIVIDEND_INCOME"
  Other income                       → CoA accountClass = "REVENUE" and not above

EXPENSES
  Management fees                    → CoA accountSubClass = "MANAGEMENT_FEE_EXPENSE"
  Professional fees                  → CoA accountSubClass = "PROFESSIONAL_FEE"
  Administrative expenses            → CoA accountSubClass = "ADMIN_EXPENSE"
  Other expenses                     → CoA accountClass = "EXPENSE" and not above

NET INVESTMENT INCOME (LOSS)         → Total Revenue - Total Expenses

REALIZED AND UNREALIZED GAINS (LOSSES)
  Net realized gain (loss)           → CoA accountSubClass = "REALIZED_GAIN_LOSS"
  Net unrealized gain (loss)         → CoA accountSubClass = "UNREALIZED_GAIN_LOSS"
  FX gain (loss)                     → CoA accountSubClass = "FX_GAIN_LOSS"

NET INCREASE (DECREASE) IN NET ASSETS FROM OPERATIONS
  = Net Investment Income + Realized + Unrealized + FX
```

### Statement of Changes in Partners' Capital
```
Per Investor (investorId dimension on JournalLines):
  Beginning balance                  → JournalLines sum through prior period-end
  + Capital contributions            → accountSubClass = "PARTNER_CAPITAL_CONTRIBUTION"
  + Allocation of net investment income → accountSubClass includes income/expense allocations
  + Allocation of realized gains     → accountSubClass = "REALIZED_GAIN_LOSS_ALLOC"
  + Allocation of unrealized gains   → accountSubClass = "UNREALIZED_GAIN_LOSS_ALLOC"
  - Distributions                    → accountSubClass = "PARTNER_CAPITAL_DISTRIBUTION"
  - Carried interest allocation      → accountSubClass = "CARRIED_INTEREST_ALLOC"
  = Ending balance
```

---

## LLM Quick Reference: "How do I..."

| Question | Answer |
|----------|--------|
| Get an LP's capital account balance? | Aggregate JournalLines WHERE investorId = LP, accountClass = "EQUITY" |
| Get a fund's NAV? | Aggregate JournalLines: total ASSET balance - total LIABILITY balance |
| Get the latest valuation of an investment? | `db.valuations.findOne({ investmentId }).sort({ valuationDate: -1 })` |
| Check if a period is open? | `db.accountingperiods.findOne({ fundId, periodCode })` → check `status` |
| Find unfunded commitment for an LP? | `LP.commitment - SUM(capitalcall allocations) + SUM(recallable distributions)` |
| Get trial balance? | See [004](004-accounting-engine.md) → LLM Math Operations |
| Trace who approved a journal? | `db.audittrails.find({ targetModel: "Journal", targetId, action: "APPROVE" })` |
| Find all investments in a company? | `db.investments.find({ companyName, organizationId })` |
| Get bank reconciliation status? | `db.banktransactions.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } }}])` |
| Get LP's DPI? | `SUM(distributions to LP) / SUM(contributions from LP)` |
