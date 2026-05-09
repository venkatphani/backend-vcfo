# Accounting Engine — LLM Reference (Layers 2 & 3)

> Covers: Fund, FundRole, ChartOfAccounts, AccountingPeriod, FxRate, Journal, JournalLine

---

## How It All Fits Together

```
Organization
└── Fund (functionalCurrency: "USD")
    ├── ChartOfAccounts
    │   ├── 1100 Cash (ASSET, DEBIT-normal)
    │   ├── 1200 Investments at FV (ASSET, DEBIT-normal, requiresInvestment: true)
    │   ├── 2100 Payables (LIABILITY, CREDIT-normal)
    │   ├── 3100 Partner Capital - Contributions (EQUITY, CREDIT-normal, requiresInvestor: true)
    │   ├── 4100 Realized Gains (REVENUE, CREDIT-normal, requiresInvestment: true)
    │   └── 5100 Management Fees (EXPENSE, DEBIT-normal)
    │
    ├── AccountingPeriods
    │   ├── 2026-01 (OPEN)
    │   ├── 2026-02 (OPEN)
    │   └── 2025-12 (HARD_CLOSED)
    │
    ├── Journals
    │   └── JE-2026-0000042 (POSTED, type: CAPITAL_CALL, period: 2026-01)
    │       ├── Line 1: DR Cash 1,000,000 USD
    │       ├── Line 2: CR Partner Capital - LP Alice 600,000 USD (investorId: alice)
    │       └── Line 3: CR Partner Capital - LP Bob 400,000 USD (investorId: bob)
    │
    └── FundRoles
        ├── Alice (FUND_MANAGER)
        └── Bob (ANALYST)
```

## Collection Quick Reference

| Collection | Key Fields | Primary Index |
|------------|-----------|---------------|
| `funds` | organizationId, legalName, functionalCurrency, status | { organizationId: 1, slug: 1 } unique |
| `fundroles` | fundId, identityId, role, status | { fundId: 1, organizationMemberId: 1 } unique |
| `chartofaccounts` | fundId, accountCode, accountName, accountClass, normalBalance | { fundId: 1, accountCode: 1 } unique |
| `accountingperiods` | fundId, periodCode, startDate, endDate, status | { fundId: 1, periodCode: 1 } unique |
| `fxrates` | fromCurrency, toCurrency, rateDate, rateType, rate | { org, from, to, date, type } unique |
| `journals` | fundId, journalNumber, journalType, status, periodId | { fundId: 1, periodId: 1, status: 1 } |
| `journallines` | journalId, fundId, accountId, functional[Debit/Credit], investorId | { fundId: 1, accountId: 1, periodId: 1 } |

---

## LLM Math Operations

### Trial Balance

```javascript
// Get trial balance for Fund X, Period Y
db.journallines.aggregate([
  { $lookup: {
      from: "journals",
      localField: "journalId",
      foreignField: "_id",
      as: "journal"
  }},
  { $unwind: "$journal" },
  { $match: {
      fundId: ObjectId("..."),
      periodId: ObjectId("..."),
      "journal.status": "POSTED"
  }},
  { $group: {
      _id: "$accountId",
      accountCode: { $first: "$accountCode" },
      accountName: { $first: "$accountName" },
      totalDebit:  { $sum: "$functionalDebit" },
      totalCredit: { $sum: "$functionalCredit" }
  }},
  { $sort: { accountCode: 1 } }
])
// VALIDATION: Grand total of all debits MUST equal grand total of all credits
```

### Account Balance (running)

```javascript
// Balance of account 1100 (Cash) as of a specific date
db.journallines.aggregate([
  { $lookup: { from: "journals", localField: "journalId", foreignField: "_id", as: "j" }},
  { $unwind: "$j" },
  { $match: {
      fundId: ObjectId("..."),
      accountId: ObjectId("...account1100..."),
      "j.status": "POSTED",
      "j.transactionDate": { $lte: ISODate("2026-03-31") }
  }},
  { $group: {
      _id: null,
      totalDebit:  { $sum: "$functionalDebit" },
      totalCredit: { $sum: "$functionalCredit" }
  }}
])
// Balance = totalDebit - totalCredit
// For DEBIT-normal (Assets, Expenses): positive = normal
// For CREDIT-normal (Liabilities, Equity, Revenue): negative = normal (display as positive)
```

### LP Capital Account Statement

```javascript
// All capital activity for investor "alice" in Fund X
db.journallines.aggregate([
  { $lookup: { from: "journals", localField: "journalId", foreignField: "_id", as: "j" }},
  { $unwind: "$j" },
  { $match: {
      fundId: ObjectId("..."),
      investorId: ObjectId("...alice..."),
      "j.status": "POSTED"
  }},
  { $lookup: {
      from: "chartofaccounts",
      localField: "accountId",
      foreignField: "_id",
      as: "account"
  }},
  { $unwind: "$account" },
  { $group: {
      _id: "$account.accountSubClass",
      totalDebit:  { $sum: "$functionalDebit" },
      totalCredit: { $sum: "$functionalCredit" }
  }}
])
// Groups by: PARTNER_CAPITAL_CONTRIBUTION, PARTNER_CAPITAL_DISTRIBUTION,
//            CARRIED_INTEREST_ALLOC, etc.
```

### FX Revaluation

```javascript
// At period-end, for each monetary account with foreign currency lines:
// 1. Find all lines where transactionCurrency != functionalCurrency
// 2. Get current balance at book rate (existing functional amounts)
// 3. Get period-end spot rate from FxRate collection
// 4. Compute: revalAmount = foreignBalance × periodEndRate - currentFunctionalBalance
// 5. Post a journal:
//    DR/CR Account (revaluation amount)
//    CR/DR FX Gain/Loss (offset)
```

---

## Posting Validation Checklist

Before a Journal transitions from DRAFT → POSTED, ALL of these must be true:

| # | Check | How |
|---|-------|-----|
| 1 | Period is OPEN or SOFT_CLOSED | Query AccountingPeriod by periodId |
| 2 | SUM(functionalDebit) = SUM(functionalCredit) across all lines | Aggregate JournalLines |
| 3 | Every line has a valid, active, postable accountId | Join ChartOfAccounts |
| 4 | Required dimensions are present | Check account.requiresInvestor/requiresInvestment vs line.investorId/investmentId |
| 5 | FX rates exist for all foreign currency lines | Query FxRate for each unique (from, to, date) |
| 6 | No duplicate journal number | Atomic journalNumber assignment in transaction |
| 7 | If SOFT_CLOSED period: journalType must be ADJUSTING or CLOSING | Check journalType |
| 8 | Posting identity has POST_JOURNAL permission | Check OrganizationMember.role |

**All 8 checks happen inside a single MongoDB transaction.**

---

## Decimal128 Handling

All monetary amounts are `Decimal128`. In application code:

```javascript
// Reading: convert to string or number for math
const amount = parseFloat(line.functionalDebit.toString());

// Writing: pass as string to avoid floating-point
line.functionalDebit = mongoose.Types.Decimal128.fromString("1000000.00");

// Aggregation: MongoDB handles Decimal128 natively in $sum, $subtract, etc.
```

---

## Migration Mappings

### Entity + FundInfo → Fund

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| Entity.name | Fund.legalName | Direct |
| Entity.type ("FUND","SPV",etc.) | Fund.vehicleStructure | Map: "FUND"→"CLOSED_END_LP", "SPV"→"SPV" |
| Entity.fundFamily | Fund.fundFamily | Direct |
| FundInfo.fundSize | Fund.targetFundSize | Cast to Decimal128 |
| FundInfo.currency | Fund.functionalCurrency | Normalize to ISO 4217 |
| FundInfo.vintageYear | Fund.vintageYear | Cast String→Number |
| FundInfo.carriedInterest | Fund.economics.carriedInterestRate | Cast to Decimal128, divide by 100 |
| FundInfo.hurdleRate | Fund.economics.hurdleRate | Cast to Decimal128, divide by 100 |
| FundInfo.managementFeeCalcBasis | Fund.economics.managementFeeCalcBasis | Map strings |
| FundInfo.waterfallType | Fund.economics.waterfallType | Map strings |
| FundInfo.dateFormed | Fund.timeline.dateFormed | Direct |
| FundInfo.firstClosingDate | Fund.timeline.firstClosingDate | Direct |
| FundInfo.fundDomicile | Fund.domicile | Normalize to ISO 3166 |

### AccountMapping → ChartOfAccounts

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| entityId | fundId (via lookup) | Entity→Fund mapping |
| accountName | accountName | Direct |
| accountNumber | accountCode | Cast Number→String |
| type | accountClass + accountSubClass | Map: "Cash"→ASSET/CASH, "Expense"→EXPENSE/OTHER_EXPENSE, "Investment"→ASSET/INVESTMENT_AT_FV |
| isDefault | isDefault | Direct |
| visible | isActive | Direct |
| — | normalBalance | Auto-derived from accountClass |

### JournalEntry → Journal

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| fundId | fundId (via FundInfo→Fund lookup) | Indirect |
| dateOfJournalEntry | transactionDate | Direct |
| eventType | journalType | Map free strings to enum |
| entryDescription | description | Direct |
| debitAmount / creditAmount | — | REMOVED from header. Amounts are on JournalLine only. |
| capitalCall | sourceDocumentId + sourceModule:"CAPITAL_CALL" | Decoupled |
| distribution | sourceDocumentId + sourceModule:"DISTRIBUTION" | Decoupled |
| — | status | Default old entries to "POSTED" |
| — | periodId | Derive from transactionDate + fund fiscal calendar |

### JournalLedger → JournalLine

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| journalId | journalId | Direct (after Journal migration) |
| accountType | accountId | Look up by old type→new CoA |
| debitAmount | functionalDebit | Use as functional (old system was single-currency) |
| creditAmount | functionalCredit | Use as functional |
| originalDebitAmount | transactionDebit | If different from debit (FX) |
| originalCreditAmount | transactionCredit | If different from credit (FX) |
| currencyDrAmount1 | transactionCurrency | Direct |
| fXRateDrAmount1 | fxRateTxnToFunctional | Direct |
| partner | investorId | Map via Role→Investor lookup |
| portfolioCompany | investmentId | Map via FundPortCoInfo→Investment lookup |
| — | reportingDebit/Credit | Set equal to functional for v1 (single-currency migration) |
| — | lineNumber | Assign sequentially per journal |
