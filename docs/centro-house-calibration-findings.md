# Centro House calibration findings

Status: **blocked pending commercial/accounting evidence**  
Evidence captured: 2026-07-31  
Scope: one Guesty listing, Booking.com and Airbnb, finalized Welcome primary documents plus separate TAKK documents.

This document is deliberately sanitized. Guest names, confirmation codes, reservation IDs, MARKs, UIDs and source PDF paths remain only in the Git-ignored local evidence bundle:

```text
tmp/centro-house-calibration-analysis-2026-07-31.md
```

## Decisions already established

1. No accommodation in this portfolio is treated as a VAT-exempt short-term-rental receipt. The supported primary flows are `11.2` APY and `2.1` TPY with the company-approved 13% VAT treatment.
2. TAKK is a separate `8.2` non-VAT document. It never enters the VAT base or gross value of the APY/TPY.
3. The TAKK amount is versioned per listing, licensed property category, validity period and night. A Guesty fee named environmental/lodging tax is evidence only and is never the statutory TAKK source.
4. APY versus TPY depends on the actual recipient and contractual chain, not on which platform collected the card payment.
5. Airbnb collection alone does not justify a TPY to Airbnb Ireland. A TPY route requires contract evidence that Airbnb is the actual B2B recipient, purchaser/reseller or deemed supplier. Otherwise a private guest accommodation supply uses APY.
6. OTA host commission is a separate expense and must not silently reduce accommodation revenue.

## Guesty amount-source decision

The bridge must not use `hostPayout` as the sole fiscal amount source.

The preferred authoritative evidence is a stable Guest Folio invoice-item snapshot. Every approved rule must explicitly match the stored line using at least:

- `normalType`
- `origin`
- `secondIdentifier` where present
- `totalPrice` at full precision
- `isDeducted` and `isDeductedV2`
- adjustment provenance

Guesty overview totals such as `hostPayout`, `hostOriginalPayout`, `fareAccommodationAdjusted`, taxes, fees and commissions are retained as immutable diagnostic and reconciliation evidence. They do not become the fiscal source merely because one sample happens to match.

The current client already performs bracketed stable reads and requests itemized financial components. A future additive change should persist a sanitized immutable projection of the overview diagnostics that are already fetched.

## Centro House evidence outcome

Six finalized Welcome primary/TAKK pairs were matched exactly to confirmed, single-listing Guesty reservations.

### Booking.com

- Three samples reconcile when the Welcome primary and separate TAKK are compared with the Guesty aggregate candidate.
- One sample has an unexplained EUR 0.58 difference.
- Guesty exposes EUR 178.58 for that sample and no EUR 178.00 total in the inspected v3 payload.
- The difference is not an allowed rounding tolerance. The exact Booking.com gross price, Guesty activity/adjustment history and Welcome manual change require evidence before approval.
- The whole exact Booking.com tuple remains blocked; the passing samples cannot be cherry-picked.

### Airbnb

- Two samples with the same listing/platform/source were issued through different recipient routes: one APY and one TPY.
- No inspected Guesty payment, collection, platform or source field distinguishes the routes.
- The samples also differ by one TAKK amount in the interpretation of `fareAccommodationAdjusted` as primary-only versus primary-plus-TAKK.
- The difference is not proven to arise from APY versus TPY. It may be a historical fee/deduction configuration, a manual adjustment or an incorrect historical document.
- The exact Airbnb tuple remains blocked until recipient/contract evidence and additional samples establish one deterministic rule or a real allowlisted discriminator.

## Required calibration policy

The production policy key is exact and has no source-only or cross-listing fallback:

```text
company_id
listing_id
guesty_account_id
platform_key
source_key
version
```

One versioned policy must atomically bind:

- Guesty amount-source strategy and line signatures
- APY/TPY type and actual recipient model
- series and approved counterpart data
- VAT category and income classification
- decimal/rounding version and tolerance
- evidence captures and accounting/technical approvals
- canonical policy hash

Unknown lines, changed deduction flags, stale captures, unresolved deltas or an unknown recipient model fail closed before sequence allocation or myDATA transmission.

## TAKK policy

TAKK is versioned separately from the OTA channel policy:

```text
company_id × listing_id × validity_period × version
```

The six current examples support only the observed EUR 8 per-night period for this listing. They do not establish the licensed category, low-season rate or boundary behavior. Accountant approval and low/high/boundary test vectors remain mandatory.

## Gate before implementation approval

- Explain the Booking.com EUR 0.58 difference with source evidence.
- Confirm whether the historical Airbnb APY and TPY routes were both intentional and provide the contractual recipient basis.
- Collect at least three distinct passing samples for every route that remains valid.
- Approve the company/listing VAT, E3 mapping, series, recipient and TAKK licensed category/rates with the accountant.
- Keep all unresolved tuples in dry-run/HOLD.

After those gates, implement additive versioned policy/evidence tables, immutable captures, a declarative strategy registry, two-role approvals, audited one-off exceptions and dry-run acceptance before any cutover.

## Official references

### AADE and legislation

- [AADE guide to business-issued documents](https://www.aade.gr/exypiretisi-enimerosi/hristikoi-odigoi/enarxi-epiheirimatikis-drastiriotitas/ekdidomena-stoiheia-apo-tin-epiheirisi-parastatika)
- [Greek Accounting Standards, N.4308/2014, invoice and retail-document rules](https://elib.aade.gr/elib/printview?d=%2Fgr%2Fact%2F2014%2F4308%2Fmain%2Fchp%2F3%2F)
- [VAT Code N.5144/2024](https://www.aade.gr/sites/default/files/2024-10/kodikas_fpa.pdf)
- [AADE E.2024/2024](https://www.aade.gr/sites/default/files/2024-04/e_2024_2024_ada.pdf)
- [TAKK statutory amendments, N.5162/2024](https://www.aade.gr/sites/default/files/2025-01/198_5162_1.pdf)
- [AADE TAKK return information](https://www.aade.gr/dilosi-apodosis-toy-teloys-anthektikotitas-stin-klimatiki-krisi)
- [myDATA technical releases](https://www.aade.gr/mydata/tehnikes-prodiagrafes-ekdoseis-mydata)

### Guesty

- [Guest Folio invoice items](https://open-api-docs.guesty.com/reference/getguestfolioinvoiceitems)
- [External invoicing and financial-reporting integration](https://open-api-docs.guesty.com/docs/syncing-reservation-financials-with-an-external-invoicing-or-financial-reporting-solution)
- [Guesty total payout calculation](https://help.guesty.com/hc/en-gb/articles/9390942100125-How-a-reservation-s-total-payout-amount-is-calculated)
- [Guest Folio adjustment FAQ](https://help.guesty.com/hc/en-gb/articles/34373615805213-FAQs-Managing-guest-folio-and-accounting-adjustments)

