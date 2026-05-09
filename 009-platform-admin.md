# Platform & Admin — LLM Reference (Layer 7)

> Covers: DealPipeline, ComplianceRun, InvestmentRight
> Also covers absorbed schemas: AdminControl → Investor.portalAccess, Grouping → Organization, TemplateReport → Document

---

## Collection Quick Reference

| Collection | Model | Key Fields | Primary Index |
|------------|-------|-----------|---------------|
| `dealpipeline` | DealPipeline | organizationId, fundId, companyName, status, dealType | { organizationId: 1, status: 1, createdAt: -1 } |
| `complianceruns` | ComplianceRun | organizationId, fundId, overallStatus, checks[], runStatus | { fundId: 1, createdAt: -1 } |
| `investmentrights` | InvestmentRight | investmentId, sourceDocType, rightKey, rightName | { investmentId: 1, sourceDocType: 1, rightKey: 1 } unique |

---

## DealPipeline

### What It Is
A deal in the investment pipeline — from initial screening through due diligence, IC approval, and closing. Once a deal closes, it becomes an Investment record.

### Key Principle
DealPipeline = PRE-INVESTMENT (CRM/workflow, no GL impact).
Investment = POST-INVESTMENT (deployed capital, hits the GL).
Many deals never close. Keeping them separate avoids polluting the Investment collection.

### Status Lifecycle
```
SCREENING → DUE_DILIGENCE → TERM_SHEET → IC_REVIEW → APPROVED → CLOSING → CLOSED_WON
                                                                          → CLOSED_LOST
                                                               → ON_HOLD
```

When CLOSED_WON:
1. Create Investment record (status: ACTIVE)
2. Set DealPipeline.investmentId = new Investment._id
3. Create Activity for the investment journal entry

### Migration: Old → New

| Old DealTracker Field | New DealPipeline Field | Notes |
|----------------------|----------------------|-------|
| entityId | organizationId | Via Entity→Organization |
| portfolioId | investmentId (if follow-on) or companyName | Map FundPortCoInfo→Investment |
| shareClass | shareClass | Direct |
| type ("Initial"/"Follow-on"/"New") | dealType | Map: "Initial"→INITIAL, "Follow-on"→FOLLOW_ON, "New"→INITIAL |
| dealType ("Scout Investment" etc.) | dealCategory | Map strings to enum |
| securityType | securityType | Map strings to enum |
| amount | amount | Cast to Decimal128 |
| reserves | reserves | Cast to Decimal128 |
| status | status | Map to pipeline enum |
| dealRoles[].partner → Role | dealTeam[].identityId → Identity | Via Role→Identity |
| dealRoles[].role | dealTeam[].role | Map: "Deal Lead"→LEAD, "Deal Source"→SOURCE |
| preMoneyValuation | valuation.preMoneyValuation | Cast to Decimal128 |
| postMoneyValuation | valuation.postMoneyValuation | Cast to Decimal128 |
| totalRaise | valuation.totalRaise | Cast to Decimal128 |
| wireConfirmationStatus | wireConfirmationStatus | Map to enum |
| contactCeo/contactCoFounder | contacts.ceo/coFounder | Direct |
| docId → DocumentRoom | memoDocumentId → Document | Via DocumentRoom→Document |
| notes | notes | Direct |

---

## ComplianceRun

### What It Is
AI-powered compliance check result. Each run evaluates a fund against ASC 946 rules, LPA covenants, and internal policies. Produces structured check results with findings and recommendations.

### Check Categories
```
INVESTMENT_LIMITS      — Concentration, diversification rules
FEE_COMPLIANCE         — Management fee, carry calculation accuracy
CAPITAL_ACTIVITY       — Call/distribution procedural compliance
REPORTING              — Timeliness, completeness of LP reporting
REGULATORY             — SEC, state regulatory requirements
LPA_COVENANTS          — Fund-specific LPA provisions
TAX                    — Tax compliance, withholding
VALUATION              — Fair value methodology compliance
BANKING                — Banking controls, wire verification
```

### The Flow
```
1. User triggers compliance check (manual or via JobQueue)
2. AI agent reads fund data: journals, capital calls, distributions, valuations
3. Evaluates against ruleset (ASC 946 + LPA terms)
4. Creates ComplianceRun with check results
5. If critical non-compliant: sets lpDistributionBlocked = true
6. Generates report document (linked via reportDocumentId)
```

### Migration: Old → New

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| entityId | organizationId | Via Entity→Organization |
| fundId | fundId | Via FundInfo→Fund |
| generatedBy → Role | generatedBy → Identity | Via Role→Identity |
| overallStatus | overallStatus | Capitalize enum values |
| runStatus | runStatus | Map: "running"→RUNNING, "completed"→COMPLETED |
| checks[].status | checks[].status | Capitalize: "Compliant"→COMPLIANT |
| markdownUrl/markdownFileName | reportDocumentId → Document | Create Document record for report |
| replCallCount | agentCallCount | Renamed |

---

## InvestmentRight

### What It Is
A legal right or provision extracted from investment documents (IRA, SPA, Voting Agreement, etc.). Tracks what rights the fund has in each portfolio company for quick reference.

### Common Rights
```
IRA:              pro_rata, information_rights, registration_rights, board_observer
SPA:              representations, indemnification, closing_conditions
VOTING_AGREEMENT: board_composition, protective_provisions, drag_along
CO_SALE:          tag_along, rofr (right of first refusal)
MRL:              management_rights, inspection_rights
```

### Migration: Old → New

| Old FavoriteRights Field | New InvestmentRight Field | Notes |
|-------------------------|--------------------------|-------|
| entityId | organizationId | Via Entity→Organization |
| — | investmentId | Map via docType + entity to Investment |
| docType | sourceDocType | Map: "IRA"→IRA, "SPA"→SPA, "Voting"→VOTING_AGREEMENT, "CoSale"→CO_SALE_AGREEMENT, "MRL"→MANAGEMENT_RIGHTS, "CapTable"→CAP_TABLE, "TERM"→TERM_SHEET, "Bylaws"→BYLAWS, "COI"→COI |
| key | rightKey | Direct |
| rightName | rightName | Direct |
| description | description | Direct |

---

## Absorbed Schemas (no separate collection needed)

### AdminControl → Investor.portalAccess
GP-controlled LP portal visibility is now embedded in the Investor schema:
```javascript
investor.portalAccess = {
  isEnabled: true,
  canViewDashboard: true,
  canViewCapitalAccount: true,
  canViewScheduleOfInvest: true,
  canViewDocuments: true,
  canViewReports: true,
  canViewDistributions: true,
  canViewCapitalCalls: true,
  canViewFinancials: true,
}
```
Migration: Map AdminControl.section strings to the corresponding boolean fields.

### Grouping → Organization + Fund.fundFamily
The old Grouping schema created "firm" groups containing multiple entities/funds. In the new design, Organization IS the firm, and Fund.fundFamily groups funds within the org.
Migration: Grouping.name → Organization.legalName (if it represents a firm) or Fund.fundFamily (if it groups funds).

### TemplateReport → Document
Generated reports are Documents with `category: "REPORT"`. The HTML/PDF data goes in Document.metadata or a linked storage file.
Migration: TemplateReport.pdfUrl → Document.storageUrl, TemplateReport.title → Document.originalName, TemplateReport.status → Document.processingStatus, TemplateReport.htmls/rawData → Document.metadata.
