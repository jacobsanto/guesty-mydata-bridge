# Welcome PDF reference examples

Status: **layout and fiscal-shape reference only; not approved Centro House calibration evidence**  
Reviewed: 2026-08-12

The locally supplied Welcome PDFs demonstrate the document layout that the bridge must reproduce **after a verified myDATA MARK**. This record is deliberately sanitized: no guest name, document number, MARK, UID, address, VAT number, or local source path is retained in Git.

## What the examples establish

| Example pair | Primary document | Primary gross / VAT | Separate TAKK | Observed shape |
| --- | --- | --- | --- | --- |
| Two-night private-guest stay ending 2026-06-30 | APY 11.2 | EUR 278.00 / 13% VAT (EUR 31.98) | EUR 4.00, EUR 2.00 for each stay night | Individual accommodation rows, payment row, tax summary, AADE MARK/UID and QR area |
| Two-night Airbnb counterpart stay ending 2026-06-20 | TPY 2.1 | EUR 402.00 / 13% VAT (EUR 46.25) | EUR 4.00, EUR 2.00 for each stay night | Approved B2B counterpart block, individual accommodation rows, tax summary, AADE MARK/UID and QR area |

The examples support these implementation rules:

1. Accommodation is an independent `11.2` or `2.1` document with the approved 13% VAT treatment.
2. TAKK is a separate `8.2` document with one frozen line per stay night. It is not part of the primary VAT base.
3. The final PDF is a post-MARK artefact: MARK, UID, provider reference and QR area appear only after successful transmission and verification.
4. The actual recipient controls APY versus TPY. An Airbnb-branded TPY example is not enough to infer that every Airbnb reservation has Airbnb as its actual B2B recipient.

## Important scope mismatch

The supplied documents identify a property/room label different from `Centro House`. They must therefore **not** be attached to a Centro unified-channel policy or used to satisfy its three-sample requirement until the exact Guesty reservation, listing ID, platform/source and finalized Welcome/myDATA identity are matched.

They are suitable as a branded-PDF layout reference and as an independent example of two EUR 2.00 TAKK nights during the shown period. They do not establish Centro's licensed TAKK category, seasonal rates, Guesty amount rules, Booking.com reconciliation, or Airbnb recipient rule.

## Required next evidence

For each example to become calibration evidence, capture the matching Guesty reservation read-only and bind it to the exact:

```text
company × listing × Guesty account × platform × source × currency
```

Then store a sanitized immutable Guest Folio projection, the finalized historical document identity, computed primary/TAKK cents, and the dual approval. Any listing mismatch, unresolved recipient route, changed Guesty line, or amount delta remains `HOLD`.
