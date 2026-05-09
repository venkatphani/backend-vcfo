# Management Fee Engine & Job Queue — LLM Reference (Layer 6)

> Covers: ManagementFeeCalc, JobQueue

---

## How It All Fits Together

```
Fund I (economics.managementFeeRate: 0.02, managementFeeCalcBasis: "COMMITTED_CAPITAL")
│
├── Investor: LP Alice (commitment: $1M, feeTerms: null → uses fund default 2%)
├── Investor: LP Bob   (commitment: $500K, feeTerms.managementFeeRate: 0.015 → side letter 1.5%)
├── Investor: GP       (commitment: $166K, feeTerms.mgmtFeeWaived: true → exempt)
│
├── ManagementFeeCalcs for 2026-Q1:
│   ├── LP Alice: basis=$1M, rate=2%, fee=$5,000 (FUND_DEFAULT)
│   ├── LP Bob:   basis=$500K, rate=1.5%, fee=$1,875 (SIDE_LETTER)
│   └── GP:       basis=$166K, rate=0%, fee=$0 (EXEMPT)
│   └── Total: $6,875 → Journal: DR Mgmt Fee Expense / CR Mgmt Fee Payable
│
└── JobQueue:
    └── MANAGEMENT_FEE_CALC job (COMPLETED, 3 investors processed, took 2.3s)
```

---

## Collection Quick Reference

| Collection | Model | Key Fields | Primary Index |
|------------|-------|-----------|---------------|
| `managementfeecalcs` | ManagementFeeCalc | fundId, investorId, quarter, feeBasisAmount, appliedRate, feeAmount, status | { fundId: 1, investorId: 1, quarter: 1 } unique |
| `jobqueue` | JobQueue | organizationId, fundId, jobType, status, progressPercent | { status: 1, priority: 1, createdAt: 1 } |

---

## ManagementFeeCalc

### What It Is
The per-LP, per-quarter management fee calculation result. One record per investor per quarter. Stores everything needed to audit the fee: what basis, what rate, any overrides, proration, catch-up fees, and which journal entry booked it.

### Key Principle
Fee TERMS live on `Investor.feeTerms` (the rate, the overrides).
Fee CALCULATIONS live here (the quarterly results).
The fee schedule/formula is snapshot into `formulaSnapshot` at calculation time so historical records aren't affected by future schedule changes.

### Rate Resolution Order
```
1. Check Investor.feeTerms.mgmtFeeWaived → if true, rate = 0 (EXEMPT)
2. Check Investor.feeTerms.managementFeeRate → if set, use it (SIDE_LETTER)
3. Fall back to Fund.economics.managementFeeRate (FUND_DEFAULT)
4. Check if rate step-down applies (post-investment period) → REDUCED
```

### Fee Calculation Formula
```
Base fee:
  feeBasisAmount × (appliedRate / 4) = quarterly fee

With proration:
  feeBasisAmount × (appliedRate / 4) × (proratedDays / totalDaysInQuarter)

With split quarter (rate changed mid-quarter):
  (feeBasisAmount × preSplitRate / 4 × preSplitDays / totalDaysInQuarter) +
  (feeBasisAmount × postSplitRate / 4 × postSplitDays / totalDaysInQuarter)

Net fee:
  feeAmount + catchUpFeeAmount - feeOffsetAmount = netFeeAmount
```

### Catch-Up Fees
When an LP joins at a subsequent closing, they owe fees from fund inception:
```javascript
// LP Bob joins at second close (2026-03-15), fund started 2025-01-01
// Bob owes catch-up for 2025-Q1, Q2, Q3, Q4, and 2026-Q1

// The 2026-Q1 record for Bob:
{
  quarter: "2026-Q1",
  feeAmount: "1875.00",       // normal Q1 fee
  catchUpFeeAmount: "7500.00", // 4 quarters × $1,875 each
  netFeeAmount: "9375.00",     // total owed
  isProrated: true,            // partial Q1 (Mar 15 - Mar 31)
}
```

### Fee Offset
If the fund earns fees from portfolio companies (monitoring fees, advisory fees, board fees), LPA may require offsetting LP management fees:
```javascript
{
  feeAmount: "5000.00",
  feeOffsetAmount: "1000.00",  // 20% of $5K portfolio co fee offset
  netFeeAmount: "4000.00",     // LP pays net
}
// Offset % comes from Investor.feeTerms.mgmtFeeOffsetPercent
```

### Status Lifecycle
```
CALCULATED → POSTED (journal created)
           → WAIVED (fee waived for this LP/quarter)
           → ADJUSTED (manual correction)
           → REVERSED (journal reversed)
```

### Journal Entry Pattern
When fee calcs are posted:
```
Method 1 — Accrual (fee recognized, paid later):
  DR  5100 Management Fee Expense (LP Alice)  $5,000  [investorId: alice]
  DR  5100 Management Fee Expense (LP Bob)    $1,875  [investorId: bob]
  CR  2200 Management Fee Payable             $6,875

Method 2 — Via Capital Call (fee called from LPs):
  CapitalCall with purpose: MANAGEMENT_FEE
  DR  1100 Cash                               $6,875
  CR  3100 Partner Capital (LP Alice)          $5,000  [investorId: alice]
  CR  3100 Partner Capital (LP Bob)            $1,875  [investorId: bob]
  Plus:
  DR  3300 Mgmt Fee Allocation (LP Alice)     $5,000  [investorId: alice]
  DR  3300 Mgmt Fee Allocation (LP Bob)       $1,875  [investorId: bob]
  CR  5100 Management Fee Revenue             $6,875
```

### Common Queries

Total fees for a fund in a quarter:
```javascript
db.managementfeecalcs.aggregate([
  { $match: { fundId: ObjectId("..."), quarter: "2026-Q1", status: "POSTED" } },
  { $group: {
      _id: null,
      totalFees: { $sum: "$feeAmount" },
      totalCatchUp: { $sum: "$catchUpFeeAmount" },
      totalOffsets: { $sum: "$feeOffsetAmount" },
      totalNet: { $sum: "$netFeeAmount" },
      lpCount: { $sum: 1 }
  }}
])
```

Fee history for an LP:
```javascript
db.managementfeecalcs.find({
  investorId: ObjectId("..."),
  status: { $ne: "REVERSED" }
}).sort({ quarter: 1 })
```

### Migration: Old → New

| Old Schema | Old Field | New Field | Notes |
|-----------|-----------|-----------|-------|
| ManagementFeeQuarterly | entityId | organizationId | Via Entity→Organization |
| ManagementFeeQuarterly | fundId | fundId | Via FundInfo→Fund |
| ManagementFeeQuarterly | partner → FundCapitalInfo | investorId → Investor | Via FundCapitalInfo→Investor |
| ManagementFeeQuarterly | quarterName | quarter | Direct (normalize format to YYYY-QN) |
| ManagementFeeQuarterly | quarterStartDate | quarterStartDate | Direct |
| ManagementFeeQuarterly | quarterEndDate | quarterEndDate | Direct |
| ManagementFeeQuarterly | commitmentTillQuarter | feeBasisAmount | Cast to Decimal128 |
| ManagementFeeQuarterly | appliedRate | appliedRate | Cast to Decimal128, divide by 100 |
| ManagementFeeQuarterly | appliedRateSource | rateSource | Map: "LPA"→FUND_DEFAULT, "Side Letter"→SIDE_LETTER, "Exempt"→EXEMPT |
| ManagementFeeQuarterly | sideLetterRef | sideLetterRef | Direct |
| ManagementFeeQuarterly | feesInQuarter | feeAmount | Cast to Decimal128 |
| ManagementFeeQuarterly | catchupFees | catchUpFeeAmount | Cast to Decimal128 |
| ManagementFeeQuarterly | inceptionToDateFees | inceptionToDateFees | Cast to Decimal128 |
| ManagementFeeQuarterly | distributionConsidered | distributionOffset | Cast to Decimal128 |
| ManagementFeeQuarterly | isProrated | isProrated | Direct |
| ManagementFeeQuarterly | proratedDays | proratedDays | Direct |
| ManagementFeeQuarterly | totalDaysInQuarter | totalDaysInQuarter | Direct |
| ManagementFeeQuarterly | calculationBasis | calculationBasis | Map: "committed_capital"→COMMITTED_CAPITAL |
| ManagementFeeQuarterly | isSplitQuarter | isSplitQuarter | Direct |
| ManagementFeeQuarterly | calculatedAt | calculatedAt | Direct |
| ManagementFeeQuarterly | calculatedBy → Role | calculatedBy → Identity | Via Role→Identity |
| ManagementFeesFundCapital | partner + year + quarter + fees | — | Superseded by ManagementFeeCalc (richer data) |
| ManagementFeeSchedule | managementFeeSchedule + formula | formulaSnapshot | Snapshot at calc time |
| ManagementFeeSchedule | partnerId | — | Schedule data now on Investor.feeTerms |
| ManagementFeeExport | * | → Document (category: REPORT, documentType: "Management Fee Export") | Export file is a Document |

---

## JobQueue

### What It Is
A generic async job queue. Any operation that's too slow for a synchronous API call gets queued here. Workers poll for QUEUED jobs, process them, and update status.

### Key Principle
One queue schema for ALL job types. The old system had ManagementFeeQueue specifically for fees. The new design handles fees, carry calcs, FX reval, report generation, bulk imports — all with the same schema. `jobType` distinguishes the work. `input`/`output` (Mixed fields) carry type-specific data.

### Job Types

| Job Type | What It Does | Produces |
|----------|-------------|----------|
| MANAGEMENT_FEE_CALC | Calculate quarterly fees for all LPs | ManagementFeeCalc records + Journal |
| CARRY_CALCULATION | Calculate carried interest | Journal entries |
| FX_REVALUATION | Period-end FX reval | Journal entries |
| VALUATION_BATCH | Update valuations for all investments | Valuation records |
| CAPITAL_CALL_ALLOC | Compute per-LP allocations | CapitalCall.allocations[] |
| DISTRIBUTION_ALLOC | Compute per-LP distributions | Distribution.allocations[] |
| REPORT_GENERATION | Generate financial statements | Document |
| BULK_IMPORT | Import CSV/Excel data | Various records |
| PERIOD_CLOSE | Run period-end checklist | Multiple journals |
| COMPLIANCE_CHECK | Run compliance rules | ComplianceRun results |
| DOCUMENT_PROCESSING | AI parse document batch | Document.aiExtractedData |
| BANK_SYNC | Sync bank transactions | BankTransaction records |

### Status Lifecycle
```
QUEUED → IN_PROGRESS → COMPLETED
                     → FAILED → RETRYING → COMPLETED
                                          → FAILED (max retries)
       → CANCELLED
```

### Duplicate Prevention
The partial filter index prevents duplicate active jobs:
```javascript
// Before queuing, check:
const active = await JobQueue.findOne({
  fundId,
  jobType: "MANAGEMENT_FEE_CALC",
  status: { $in: ["QUEUED", "IN_PROGRESS"] }
});
if (active) throw new Error("Fee calculation already in progress");
```

### Worker Pattern
```javascript
// Worker picks up next job:
const job = await JobQueue.findOneAndUpdate(
  { status: "QUEUED", priority: { $lte: 5 } },
  { $set: { status: "IN_PROGRESS", startedAt: new Date(), workerId: process.env.WORKER_ID } },
  { sort: { priority: 1, createdAt: 1 }, new: true }
);

// Process...
// Update progress:
await JobQueue.updateOne({ _id: job._id }, {
  progressPercent: 50,
  progressMessage: "Processed 8 of 16 investors",
  processedItems: 8
});

// Complete:
await JobQueue.updateOne({ _id: job._id }, {
  status: "COMPLETED",
  completedAt: new Date(),
  durationMs: Date.now() - job.startedAt,
  output: { totalFees: "6875.00", partnerCount: 3, journalIds: [...] }
});
```

### Migration: Old → New

| Old ManagementFeeQueue Field | New JobQueue Field | Notes |
|------------------------------|-------------------|-------|
| entityId | organizationId | Via Entity→Organization |
| fundId | fundId | Via FundInfo→Fund |
| status | status | Map: "QUEUED"→QUEUED, "IN_PROGRESS"→IN_PROGRESS, "COMPLETED"→COMPLETED, "FAILED"→FAILED |
| triggeredBy → Role | triggeredBy → Identity | Via Role→Identity |
| sqsMessageId | queueMessageId | Direct |
| dataGenerated | output | Direct |
| errorMessage | errorMessage | Direct |
| startedAt | startedAt | Direct |
| completedAt | completedAt | Direct |
| type ("Management Fees") | jobType: "MANAGEMENT_FEE_CALC" | Map string to enum |
