# Fund Operations — LLM Reference (Layer 4A)

> Covers: Investor, Investment, Valuation, CapitalCall, Distribution

---

## How It All Fits Together

```
Fund
├── Investors (LP/GP capital accounts)
│   ├── LP Alice  (commitment: $1M, ownership: 60%)
│   ├── LP Bob    (commitment: $500K, ownership: 30%)
│   └── GP Entity (commitment: $166K, ownership: 10%)
│
├── Investments (portfolio companies)
│   ├── Acme Corp (EQUITY, Series A, $500K cost basis)
│   │   ├── Valuation 2025-12-31: FV $600K (unrealized +$100K)
│   │   └── Valuation 2026-03-31: FV $800K (unrealized +$200K)
│   └── Beta Inc  (SAFE, $200K cost basis)
│       └── Valuation 2025-12-31: FV $250K (unrealized +$50K)
│
├── Capital Calls
│   └── CC-2026-001 (total: $500K)
│       ├── Allocation: LP Alice — $300K (60%)
│       ├── Allocation: LP Bob   — $150K (30%)
│       └── Allocation: GP       — $50K  (10%)
│       └── → Journal: DR Cash $500K / CR Partner Capital (per LP)
│
└── Distributions
    └── DIST-2026-001 (total: $200K, source: Acme partial exit)
        ├── Allocation: LP Alice — $120K (ROC: $60K, Realized Gain: $60K)
        ├── Allocation: LP Bob   — $60K  (ROC: $30K, Realized Gain: $30K)
        └── Allocation: GP       — $20K  (Carried Interest: $20K)
        └── → Journal: DR Partner Capital (per LP) / CR Cash $200K
```

---

## Collection Quick Reference

| Collection | Key Fields | Primary Index |
|------------|-----------|---------------|
| `investors` | fundId, legalName, investorType, commitment, ownershipPercent, status | { fundId: 1, legalName: 1 } unique |
| `investments` | fundId, companyName, instrumentType, investmentAmount, costBasis, status | { fundId: 1, companyName: 1, roundName: 1 } unique |
| `valuations` | fundId, investmentId, valuationDate, fairValue, fairValueLevel | { fundId: 1, investmentId: 1, valuationDate: 1 } unique |
| `capitalcalls` | fundId, callNumber, totalCallAmount, callDate, dueDate, status | { fundId: 1, callNumber: 1 } unique |
| `distributions` | fundId, distributionNumber, totalDistributionAmount, distributionDate, status | { fundId: 1, distributionNumber: 1 } unique |

---

## Investor

### What It Is
An LP or GP investor in a specific Fund. One Identity can be an Investor in multiple Funds (each gets its own record). Tracks commitment, fee terms (side letter overrides), banking, tax, accreditation, KYC/AML, and onboarding.

### Key Principle
The Investor schema stores TERMS and COMMITMENT. The investor's capital account BALANCE is derived from JournalLines tagged with `investorId`. Never store a running balance on the Investor document.

### Status Lifecycle
```
PROSPECT → ONBOARDING → ACTIVE → DEFAULTED
                              → TRANSFERRED
                              → REDEEMED (evergreen)
                              → INACTIVE (fund terminated)
```

### Fee Terms (Side Letter Overrides)
If `feeTerms` is null/undefined, the fund-level defaults from `Fund.economics` apply. Each field in `feeTerms` independently overrides:

| Fee Term | Fund Default Source | Override Field |
|----------|-------------------|----------------|
| Management fee rate | Fund.economics.managementFeeRate | investor.feeTerms.managementFeeRate |
| Carried interest | Fund.economics.carriedInterestRate | investor.feeTerms.carriedInterestRate |
| Hurdle rate | Fund.economics.hurdleRate | investor.feeTerms.hurdleRate |
| Fee waiver | — | investor.feeTerms.mgmtFeeWaived |
| Fee offset | — | investor.feeTerms.mgmtFeeOffsetPercent |

### Commitment History
Embedded array tracking every commitment change:
```javascript
investor.commitmentHistory = [
  { changeType: "INITIAL", amount: "1000000", effectiveDate: "2025-01-15", status: "COMPLETED" },
  { changeType: "INCREASE", amount: "500000", effectiveDate: "2025-06-01",
    previousAmount: "1000000", newAmount: "1500000", status: "LP_SIGNED" },
]
```

### Sensitive Field Handling
These fields are ALWAYS redacted in API responses and audit logs:
- `banking.accountNumber` → masked to last 4 digits
- `banking.routingNumber`, `banking.wireRouting`, `banking.iban`
- `taxInfo.taxId` → masked to last 4 digits
- `kyc.verificationId`, `kyc.amlScreeningId`

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| Role | roleType = "LP" or "GP" | investorType | Map LP→LP, GP→GP |
| Role | entityName | legalName | Direct |
| Role | email | email | Direct |
| Role | entityType | entityType | Map strings |
| Role | accreditedInvestor | accreditation.isAccredited | Direct |
| Role | qualifiedPurchaser | accreditation.isQualifiedPurchaser | Direct |
| FundCapitalInfo | commitment | commitment | Cast to Decimal128 |
| FundCapitalInfo | ownershipPercentage | ownershipPercent | Cast to Decimal128, divide by 100 |
| FundCapitalInfo | distributionBankInfo | banking.* | Decompose |
| Role | taxFormType | taxInfo.taxFormType | Direct |
| Role | kycStatus | kyc.status | Map strings |
| CommitmentHistory | * | commitmentHistory[] | Embed into investor document |

---

## Investment

### What It Is
A portfolio company or individual investment asset held by a Fund. Each investment round/tranche is a separate record. Follow-on investments link back via `initialInvestmentId`.

### Key Principle
Investment stores DEAL TERMS (static after purchase). Current VALUE lives in the latest Valuation record. Cost basis comes from JournalLines tagged with `investmentId`.

### Instrument Type → GL Account Mapping
```
EQUITY            → 1210 Equity Securities at FV
CONVERTIBLE_NOTE  → 1220 Convertible Notes at FV
SAFE              → 1230 SAFEs at FV
DEBT              → 1240 Debt Securities
WARRANT           → 1250 Warrants
LP_INTEREST       → 1260 Other Fund Interests
```

### Status Lifecycle
```
PIPELINE → COMMITTED → ACTIVE → PARTIALLY_EXITED → EXITED
                            → MARKED_DOWN
                            → WRITTEN_OFF
                            → CONVERTED (SAFE/note → equity)
```

### Follow-On Tracking
```javascript
// Find all investments in the same company
db.investments.find({
  $or: [
    { _id: initialInvestmentId },
    { initialInvestmentId: initialInvestmentId }
  ]
})
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| FundPortCoInfo | portCoName | companyName | Direct |
| FundPortCoInfo | sector | sector | Direct |
| FundPortCoInfo | stage | stage | Map strings |
| FundPortCoInvestmentInfo | investmentDate | investmentDate | Direct |
| FundPortCoInvestmentInfo | investmentAmount | investmentAmount | Cast to Decimal128 |
| FundPortCoInvestmentInfo | instrumentType | instrumentType | Map strings |
| FundPortCoInvestmentInfo | pricePerShare | terms.pricePerShare | Cast to Decimal128 |
| FundPortCoInvestmentInfo | sharesAcquired | terms.sharesAcquired | Cast to Decimal128 |
| FundPortCoInvestmentInfo | exitType | exit.exitType | Map strings |
| FundPortCoInvestmentInfo | exitDate | exit.exitDate | Direct |
| FundPortCoInvestmentInfo | exitProceeds | exit.exitProceeds | Cast to Decimal128 |

---

## Valuation

### What It Is
A fair value mark for a specific Investment at a specific date. Append-only time series — one record per investment per valuation date.

### Key Principle
The LATEST valuation per investment is the "current fair value" for financial statements. Unrealized gain/loss = fairValue - previousValue (stored as `unrealizedChange`).

### ASC 820 Fair Value Levels
```
LEVEL_1: Quoted prices in active markets (public stocks)
LEVEL_2: Observable inputs (comparable transactions, market multiples)
LEVEL_3: Unobservable inputs (DCF, OPM, internal models) — most VC/PE
```

### Common Queries

Get latest valuation for an investment:
```javascript
db.valuations.findOne({
  investmentId: ObjectId("..."),
  status: "APPROVED"
}).sort({ valuationDate: -1 })
```

Schedule of Investments at period-end:
```javascript
// For each active investment, get latest approved valuation
db.investments.aggregate([
  { $match: { fundId: ObjectId("..."), status: { $in: ["ACTIVE", "MARKED_DOWN"] } } },
  { $lookup: {
      from: "valuations",
      let: { invId: "$_id" },
      pipeline: [
        { $match: {
            $expr: { $eq: ["$investmentId", "$$invId"] },
            valuationDate: { $lte: ISODate("2026-03-31") },
            status: "APPROVED"
        }},
        { $sort: { valuationDate: -1 } },
        { $limit: 1 }
      ],
      as: "latestVal"
  }},
  { $unwind: { path: "$latestVal", preserveNullAndEmptyArrays: true } },
  { $project: {
      companyName: 1,
      instrumentType: 1,
      costBasis: 1,
      fairValue: "$latestVal.fairValue",
      unrealizedGainLoss: { $subtract: ["$latestVal.fairValue", "$costBasis"] },
      fairValueLevel: "$latestVal.fairValueLevel",
      valuationMethod: "$latestVal.valuationMethod"
  }}
])
```

---

## CapitalCall

### What It Is
A capital call event for a Fund. Per-LP allocations are embedded as `allocations[]`. Posting auto-generates journal entries.

### Journal Entry Pattern
When a capital call is posted:
```
DR  1100 Cash (or 1300 Capital Call Receivable)    $1,000,000
CR  3100 Partner Capital - Contributions (LP Alice)  $600,000   [investorId: alice]
CR  3100 Partner Capital - Contributions (LP Bob)    $400,000   [investorId: bob]
```

If the call includes management fees:
```
DR  1100 Cash                                      $200,000
CR  3100 Partner Capital - Contributions (LP Alice)  $120,000   [investorId: alice]
CR  3100 Partner Capital - Contributions (LP Bob)     $80,000   [investorId: bob]
DR  3300 Management Fee Allocation (LP Alice)        $120,000   [investorId: alice]
DR  3300 Management Fee Allocation (LP Bob)           $80,000   [investorId: bob]
CR  5100 Management Fee Revenue                      $200,000
```

### Purpose Breakdown
Each call can fund multiple purposes:
```javascript
capitalCall.purposes = [
  { purposeType: "INVESTMENT", amount: "500000", investmentId: "...", description: "Acme Corp Series A" },
  { purposeType: "MANAGEMENT_FEE", amount: "200000", description: "Q1 2026 management fee" },
  { purposeType: "OPERATING_EXPENSE", amount: "50000", description: "Fund legal expenses" },
]
```

### Allocation Basis
- **COMMITMENT**: pro-rata based on total commitment (most common)
- **UNFUNDED**: pro-rata based on remaining unfunded commitment
- **CUSTOM**: manually set per LP (for catch-up calls, etc.)

### Status Lifecycle
```
DRAFT → APPROVED → ISSUED → PARTIALLY_FUNDED → FULLY_FUNDED
                                              → OVERDUE
                        → CANCELLED
```

### LP Math
```
Call amount per LP = totalCallAmount × (LP.commitment / fund.totalCommitments)
Total called to date = SUM(all CapitalCall.allocations[investorId=LP].callAmount WHERE status != CANCELLED)
Unfunded commitment = LP.commitment - total called + recallable distributions
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| FundCapitalCall | callAmount | totalCallAmount | Cast to Decimal128 |
| FundCapitalCall | callDate | callDate | Direct |
| FundCapitalCall | dueDate | dueDate | Direct |
| FundCapitalCall | status | status | Map strings |
| Transaction (type=CAPITAL_CALL) | roleId | allocations[].investorId | Map via Role→Investor lookup |
| Transaction | amount | allocations[].callAmount | Cast to Decimal128 |
| Transaction | receivedDate | allocations[].receivedDate | Direct |
| Transaction | writeOff | allocations[].writeOff | Direct |
| Transaction | journalId | journalId | Direct |

---

## Distribution

### What It Is
A distribution event from a Fund to its LPs. Per-LP allocations with economic character breakdown (critical for tax reporting).

### Journal Entry Pattern
When a distribution is posted:
```
DR  3200 Partner Capital - Distributions (LP Alice)  $120,000  [investorId: alice]
DR  3200 Partner Capital - Distributions (LP Bob)     $60,000  [investorId: bob]
DR  3200 Partner Capital - Distributions (GP)          $20,000  [investorId: gp]
CR  1100 Cash                                         $200,000
```

### Character Breakdown
Each LP's distribution is characterized for tax reporting:
```javascript
allocation.character = {
  returnOfCapital:  "60000",   // returning contributed capital
  realizedGain:     "50000",   // profit from exit
  carriedInterest:  "0",       // GP carry (only on GP allocation)
  dividendIncome:   "10000",   // portfolio company dividend
  withholdingTax:   "-2000",   // tax withheld
}
// Sum of all character amounts = distributionAmount
```

### Waterfall Calculation
For WATERFALL allocation method, the schema stores context:
```javascript
distribution.waterfall = {
  currentTier: "CARRIED_INTEREST_SPLIT",
  cumulativeContributions: "5000000",
  cumulativeDistributions: "3000000",  // before this distribution
  accruedPreferredReturn: "250000",
  gpCarriedInterest: "20000",
}
```

Waterfall tiers (European-style):
1. **RETURN_OF_CAPITAL** — return all contributed capital first
2. **PREFERRED_RETURN** — LP preferred return (e.g., 8% IRR)
3. **GP_CATCH_UP** — GP catch-up to carry split
4. **CARRIED_INTEREST_SPLIT** — remaining split (e.g., 80/20)

### Status Lifecycle
```
DRAFT → APPROVED → NOTICE_SENT → PROCESSING → PARTIALLY_DISTRIBUTED → DISTRIBUTED
                              → CANCELLED
```

### LP Math
```
Total distributed to LP = SUM(all Distribution.allocations[investorId=LP].distributionAmount WHERE status != CANCELLED)
DPI = total distributions / total contributions (per LP)
TVPI = (current NAV share + total distributions) / total contributions
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| FundCapitalDistribution | distributionAmount | totalDistributionAmount | Cast to Decimal128 |
| FundCapitalDistribution | distributionDate | distributionDate | Direct |
| FundCapitalDistribution | status | status | Map strings |
| Transaction (type=DISTRIBUTION) | roleId | allocations[].investorId | Map via Role→Investor lookup |
| Transaction | amount | allocations[].distributionAmount | Cast to Decimal128 |
| Transaction | type (sub-types) | allocations[].character.* | Map: "Return of Capital"→returnOfCapital, "Realized gain"→realizedGain |
| Transaction | journalId | journalId | Direct |

---

## Cross-Schema Queries

### LP Capital Account Statement
The definitive view of an LP's capital account — replaces the old Transaction collection:
```javascript
db.journallines.aggregate([
  { $lookup: { from: "journals", localField: "journalId", foreignField: "_id", as: "j" }},
  { $unwind: "$j" },
  { $match: {
      fundId: ObjectId("..."),
      investorId: ObjectId("...LP_ALICE..."),
      "j.status": "POSTED"
  }},
  { $lookup: { from: "chartofaccounts", localField: "accountId", foreignField: "_id", as: "acct" }},
  { $unwind: "$acct" },
  { $group: {
      _id: "$acct.accountSubClass",
      totalDebit:  { $sum: "$functionalDebit" },
      totalCredit: { $sum: "$functionalCredit" }
  }},
  { $sort: { _id: 1 } }
])
// Returns grouped by: PARTNER_CAPITAL_CONTRIBUTION, PARTNER_CAPITAL_DISTRIBUTION, etc.
// Capital account balance = SUM(all credits - all debits) on EQUITY class accounts
```

### Fund NAV Calculation
```javascript
// NAV = Total Assets - Total Liabilities
// Assets: Cash + Investments at FV + Receivables
// Liabilities: Payables + Accrued Expenses

// Step 1: Get total assets
db.journallines.aggregate([
  { $lookup: { from: "journals", localField: "journalId", foreignField: "_id", as: "j" }},
  { $unwind: "$j" },
  { $match: { fundId: ObjectId("..."), "j.status": "POSTED" }},
  { $lookup: { from: "chartofaccounts", localField: "accountId", foreignField: "_id", as: "acct" }},
  { $unwind: "$acct" },
  { $group: {
      _id: "$acct.accountClass",
      totalDebit:  { $sum: "$functionalDebit" },
      totalCredit: { $sum: "$functionalCredit" }
  }}
])
// ASSET balance = totalDebit - totalCredit (debit-normal)
// LIABILITY balance = totalCredit - totalDebit (credit-normal)
// NAV = ASSET balance - LIABILITY balance
```

### Investment Performance (MOIC, IRR inputs)
```javascript
// Per investment:
// Cost = Investment.costBasis
// Current FV = latest Valuation.fairValue
// Realized = SUM(exit proceeds from Distribution.sources WHERE investmentId = X)
// MOIC = (Current FV + Realized) / Cost
// For IRR: need cash flow dates from CapitalCall.allocations + Distribution.allocations
```
