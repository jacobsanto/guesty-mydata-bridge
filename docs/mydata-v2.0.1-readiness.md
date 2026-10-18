# myDATA production-readiness baseline

**Checked:** 31 July 2026  
**Production source of truth:** AADE ERP REST API documentation **v2.0.1 (March 2026)** and its official XSD bundle.  
**Sandbox forward check:** AADE ERP REST API **v2.0.2 preofficial (June 2026)** and the v2.0.2 XSD bundle currently published on the AADE test-environment page.

## What changed in this bridge

- The current AADE ERP specification is v2.0.1, not v1.0.9. The XML namespace used by the invoice schema remains `.../v1.0`.
- AADE's test environment now advertises preofficial v2.0.2. Its release notes concern delivery/receiving-note flows, not the accommodation document types used here. All generated `2.1`, `11.2`, `8.2`, `5.1` and `11.4` XML is nevertheless validated against both bundles.
- `11.1` means **ΑΛΠ** and `11.2` means **ΑΠΥ**. Each listing has its own configured default document type (`11.2` or `2.1`), which a reservation may explicitly override before materialization. The document type follows the actual recipient and contractual supply chain, not the payment collector or OTA name. `2.1` requires an approved B2B recipient, with `vatCategory=2` (13%) and the accountant-approved `category1_3` classification; a private accommodation recipient uses `11.2`.
- `8.2` is the separate **Τέλος Ανθεκτικότητας στην Κλιματική Κρίση** document. The bridge no longer puts that charge inside an `11.x` invoice line or treats it as an ordinary `feesPercentCategory` amount.
- `invoiceHeader.correlatedInvoices` contains AADE MARK values (`xs:long`), not Guesty reservation IDs. The bridge no longer writes Guesty IDs there.
- AADE requires `aade-user-id` and `ocp-apim-subscription-key` on every call. Credentials are encrypted at rest for companies created or updated through the admin API.

## Production blockers that require a named decision per company

1. **Recipient and counterpart mapping:** Every `2.1` requires documentary evidence that the named business is the actual recipient of the accommodation supply; OTA collection alone is insufficient. The approved policy must provide `invoiceCounterpart` (VAT ID, ISO country, branch) and the accountant-approved classification. A private recipient uses `11.2`. The recipient, branch and policy evidence are frozen in the original fiscal snapshot and reused unchanged by the correlated `5.1` credit.
2. **Climate-fee issuance flow:** Each listing owns its high- and low-season TΑΚ rates. The separate `8.2` document must be issued, numbered, cancelled, and reflected in the customer-facing receipt independently from the `2.1`/`11.2` document.
   For this portfolio, short-term-rental categories `25/26/28/29` are explicitly rejected. Rented rooms/apartments use category pair `24/10`; tourist furnished villas use `27/30`. Amounts remain configurable per listing because the category code and the legally effective amount are separate fields in myDATA.
3. **Guesty money semantics:** The dedicated Guest Folio invoice items are the authoritative source when available. The bridge includes service lines plus `VAT`, excludes Guesty tax normal types such as `CT`/`LT`, and refuses an empty authoritative folio instead of falling back to a broader total. Verify the account's actual normal-type configuration with one real reservation before sign-off.
4. **Sandbox evidence:** Submit one accountant-approved real sandbox reservation and retain the request XML, AADE response, MARK/UID, and rendered receipt before enabling production.
5. **Guesty OAuth quota:** Guesty permits only five token requests per API key per 24 hours. The bridge stores the token encrypted, reuses it across restarts, serializes refreshes across PostgreSQL instances, and refreshes once after an authenticated `401`/`403`.

## Runtime safety controls

- Production calls require `MYDATA_PRODUCTION_ENABLED=true`; `MYDATA_ENV=production` alone is not enough.
- Production runtime also requires `GUESTY_ACCOUNT_ID`. A policy is keyed by that stable account together with company, listing, platform and source; a missing account identity blocks materialization.
- Admin APIs require `ADMIN_API_TOKEN` in production.
- New or updated AADE credentials require `DATA_ENCRYPTION_KEY`, an AES-256-GCM 32-byte base64 key. Keep it in a secret manager, not in Git.
- Legacy plaintext credentials are rejected in production. Migrate them through a controlled credential rotation before go-live.

## Official references

- [AADE: technical specification releases](https://www.aade.gr/mydata/tehnikes-prodiagrafes-ekdoseis-mydata)
- [AADE: myDATA ERP REST API v2.0.1 (March 2026)](https://www.aade.gr/sites/default/files/2026-03/myDATA%20API%20Documentation%20v2.0.1_official_erp.pdf)
- [AADE: test environment and v2.0.2 preofficial release](https://www.aade.gr/mydata-ilektronika-biblia-aade/mydata/dokimastiko-periballon)
- [AADE: myDATA ERP REST API v2.0.2 preofficial (June 2026)](https://www.aade.gr/sites/default/files/2026-06/myDATA%20API%20Documentation%20v2.0.2_preofficial_erp.pdf)
