# Guesty → myDATA Production Webapp Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a production-grade internal webapp for multitenant Guesty → myDATA invoicing, with real tenant credentials, real listing-to-company mapping, admin UI, and real-data testing only after the runnable webapp is ready.

**Architecture:** Keep the current Node.js backend core, but normalize the data model from a single `tenants` table into `companies`, `listings`, and `invoices`. Add an admin webapp in Next.js for CRUD, status monitoring, and controlled real submissions. No mock/demo data should ship in the app; testing against real AADE/Guesty data happens only once the webapp is runnable and credentials are configured.

**Tech Stack:** Node.js, Express, Knex, SQLite now / PostgreSQL later, Next.js admin frontend, REST API, GitHub, AADE myDATA, Guesty webhook.

---

## Non-Negotiables

1. **No mock data in product code or seeded demo tenants.**
2. **No fake invoice success states.**
3. **Real tests only after runnable webapp + real credentials are in place.**
4. **Listing belongs to company; company owns myDATA credentials.**
5. **Keep PostgreSQL migration path clean from now.**

---

## Target Architecture

### Data model
- `companies`
  - one row per legal entity / ΑΦΜ
  - stores myDATA credentials and invoice series
- `listings`
  - one row per Guesty listing
  - references `company_id`
  - stores `property_type`
- `invoices`
  - one row per submitted reservation invoice
  - stores AADE MARK/UID, XML, status, error details

### Backend responsibilities
- Guesty webhook reception
- signature verification
- listing → company resolution
- invoice numbering
- XML generation
- myDATA submission
- admin REST API for companies/listings/invoices

### Frontend responsibilities
- companies CRUD
- listings CRUD / mapping
- invoice monitoring
- retry failed submission
- XML / response inspection
- controlled real submission tools

---

## Phase Plan

### Phase 2.1: Normalize DB schema

**Objective:** Replace the current denormalized `tenants` model with proper `companies` + `listings` structure.

**Files:**
- Modify: `src/database.js`
- Create: `src/repositories/companies.js`
- Create: `src/repositories/listings.js`
- Create: `src/repositories/invoices.js`
- Remove later: direct tenant-centric queries from `src/database.js`

**Implementation steps:**
1. Add `companies` table schema.
2. Add `listings` table schema with `company_id` foreign key.
3. Update `invoices` table to reference `company_id` and `listing_id` where appropriate.
4. Replace `getTenantByListingId()` with joined lookup `getCompanyAndListingByGuestyListingId()`.
5. Move query logic out of the monolithic DB file into repository modules.

**Validation:**
- Start server successfully.
- Verify schema creation on fresh SQLite DB.
- Read back created tables.

**Commit:**
```bash
git add src/database.js src/repositories
git commit -m "refactor: normalize companies and listings schema"
```

---

### Phase 2.2: Refactor webhook to company/listing model

**Objective:** Make the webhook resolve the correct company credentials through the normalized schema.

**Files:**
- Modify: `src/guesty-webhook.js`
- Modify: `src/mydata-xml.js`
- Modify: `src/mydata-client.js`

**Implementation steps:**
1. Replace tenant lookup with joined company/listing lookup.
2. Use company credentials for AADE submission.
3. Use listing property type for climate-fee logic.
4. Store both `company_id` and `listing_id_guesty` in invoice records.
5. Preserve idempotency behavior.

**Validation:**
- Server boots without import/query errors.
- Dry-path validation with manual route invocation after webapp exists.

**Commit:**
```bash
git add src/guesty-webhook.js src/mydata-xml.js src/mydata-client.js
git commit -m "refactor: resolve invoices through company-listing mapping"
```

---

### Phase 2.3: Add admin API for companies

**Objective:** Manage real company credentials safely through API endpoints.

**Files:**
- Create: `src/routes/companies.js`
- Create: `src/services/company-service.js`
- Modify: `src/server.js`

**Endpoints:**
- `GET /api/companies`
- `POST /api/companies`
- `PATCH /api/companies/:id`
- `GET /api/companies/:id`
- `POST /api/companies/:id/rotate-credentials`

**Rules:**
- validate VAT number format
- never log raw subscription keys
- redact secrets in API responses by default

**Validation:**
- endpoint health
- create/update/read on real DB

**Commit:**
```bash
git add src/routes/companies.js src/services/company-service.js src/server.js
git commit -m "feat: add company admin API"
```

---

### Phase 2.4: Add admin API for listings

**Objective:** Map Guesty listings to the right company and property type.

**Files:**
- Create: `src/routes/listings.js`
- Create: `src/services/listing-service.js`
- Modify: `src/server.js`

**Endpoints:**
- `GET /api/listings`
- `POST /api/listings`
- `PATCH /api/listings/:id`
- `GET /api/listings/:id`

**Rules:**
- `listing_id_guesty` unique
- `company_id` must exist
- `property_type` constrained to supported values

**Validation:**
- cannot map listing to non-existent company
- duplicate listing blocked

**Commit:**
```bash
git add src/routes/listings.js src/services/listing-service.js src/server.js
git commit -m "feat: add listing mapping admin API"
```

---

### Phase 2.5: Add invoices admin API

**Objective:** Expose invoice history and operational controls to the frontend.

**Files:**
- Create: `src/routes/invoices.js`
- Create: `src/services/invoice-service.js`
- Modify: `src/server.js`

**Endpoints:**
- `GET /api/invoices`
- `GET /api/invoices/:id`
- `POST /api/invoices/:id/retry`
- `GET /api/invoices/:id/xml`

**Validation:**
- failed invoices visible
- XML retrievable
- retry route guarded and logged

**Commit:**
```bash
git add src/routes/invoices.js src/services/invoice-service.js src/server.js
git commit -m "feat: add invoice admin API"
```

---

### Phase 2.6: Create Next.js admin webapp shell

**Objective:** Provide a browser-accessible UI at `localhost:3000`.

**Files:**
- Create: `web/package.json`
- Create: `web/app/layout.tsx`
- Create: `web/app/page.tsx`
- Create: `web/app/companies/page.tsx`
- Create: `web/app/listings/page.tsx`
- Create: `web/app/invoices/page.tsx`
- Create: `web/lib/api.ts`

**UI sections:**
- dashboard
- companies
- listings
- invoices

**Validation:**
- frontend boots
- page navigation works
- API calls reach backend

**Commit:**
```bash
git add web
git commit -m "feat: scaffold admin webapp"
```

---

### Phase 2.7: Build Companies UI

**Objective:** Allow entering real company credentials from browser UI.

**Files:**
- Modify: `web/app/companies/page.tsx`
- Create: `web/components/company-form.tsx`
- Create: `web/components/company-table.tsx`

**UI fields:**
- company name
- VAT number
- AADE user id
- AADE subscription key
- invoice series
- active flag

**Rules:**
- redact existing keys on list view
- full key only on create/update submit
- explicit warning before saving live credentials

**Validation:**
- company create/update works against real DB

**Commit:**
```bash
git add web/app/companies web/components
git commit -m "feat: add companies admin UI"
```

---

### Phase 2.8: Build Listings UI

**Objective:** Map listings to companies visually.

**Files:**
- Modify: `web/app/listings/page.tsx`
- Create: `web/components/listing-form.tsx`
- Create: `web/components/listing-table.tsx`

**UI fields:**
- Guesty listing ID
- linked company
- property type
- active flag

**Validation:**
- listing create/update works
- select company from existing list

**Commit:**
```bash
git add web/app/listings web/components
git commit -m "feat: add listings admin UI"
```

---

### Phase 2.9: Build Invoices UI

**Objective:** Monitor invoicing operations and investigate failures.

**Files:**
- Modify: `web/app/invoices/page.tsx`
- Create: `web/components/invoice-table.tsx`
- Create: `web/components/invoice-detail-drawer.tsx`

**Views:**
- sent / failed / pending filters
- MARK / UID / reservation id / company / listing
- XML preview
- error message detail
- retry action

**Validation:**
- invoices render from live DB
- retry button wired to backend

**Commit:**
```bash
git add web/app/invoices web/components
git commit -m "feat: add invoices monitoring UI"
```

---

### Phase 2.10: Authentication for internal admin

**Objective:** Protect the admin UI before real credentials/testing.

**Files:**
- Create: `src/middleware/auth.js`
- Create: `web/middleware.ts`
- Create: `web/app/login/page.tsx`
- Modify: `src/server.js`

**Minimum acceptable auth:**
- single-admin password gate or basic auth for v1
- no anonymous access to company credentials

**Validation:**
- protected routes redirect unauthenticated users
- API protected where needed

**Commit:**
```bash
git add src/middleware web/app/login web/middleware.ts
git commit -m "feat: protect admin webapp with auth"
```

---

### Phase 2.11: Remove mock-only test artifacts

**Objective:** Align the repo with the requirement for real-data testing only.

**Files:**
- Delete: `tests/smoke.js`
- Modify: `package.json`
- Modify: `README.md`

**Implementation steps:**
1. Remove current smoke test command.
2. Replace with operational verification steps only.
3. Document real test prerequisites.

**Validation:**
- `package.json` scripts no longer imply fake/demo testing

**Commit:**
```bash
git add -A
git commit -m "chore: remove mock-based verification path"
```

---

### Phase 2.12: Real-data operational verification

**Objective:** Test only once the webapp is runnable and real credentials exist.

**Preconditions:**
- backend running
- frontend running
- at least one real company configured
- at least one real listing mapped
- real Guesty webhook configured
- real AADE sandbox or production credentials available

**Verification steps:**
1. Open webapp in browser.
2. Create company with real AADE credentials.
3. Create listing mapped to that company.
4. Verify records appear in UI and DB.
5. Send one controlled real reservation flow.
6. Verify invoice appears with real MARK/UID.
7. Inspect stored XML and AADE response.
8. Confirm duplicate webhook does not create a second invoice.

**Evidence to capture:**
- browser screenshot
- DB row presence
- AADE MARK
- API response JSON
- clean logs

**Commit:**
```bash
git add README.md
# commit only docs/config changes if any; do not commit secrets
```

---

## Files likely to change overall

### Backend
- `src/database.js`
- `src/guesty-webhook.js`
- `src/mydata-xml.js`
- `src/mydata-client.js`
- `src/server.js`
- `src/routes/*.js`
- `src/services/*.js`
- `src/repositories/*.js`
- `.env.example`
- `README.md`

### Frontend
- `web/package.json`
- `web/app/**/*`
- `web/components/**/*`
- `web/lib/api.ts`
- `web/middleware.ts`

---

## Risks / tradeoffs

1. **AADE schema edge cases** may force XML adjustments once real credentials are used.
2. **Credential handling** must avoid accidental logging or Git commits.
3. **SQLite concurrency** is acceptable for early internal use but not ideal long-term; PostgreSQL remains the production target.
4. **Guesty payload variation** may require adapting to the exact fields present in your account/webhook config.
5. **No mock testing** means some bugs surface later, during first real integration. That is acceptable here because it is a user requirement, but we should expect one stabilization pass.

---

## Recommended execution order for “ένα ένα” slices

1. Phase 2.1 — DB normalization
2. Phase 2.2 — webhook refactor
3. Phase 2.3 — companies API
4. Phase 2.4 — listings API
5. Phase 2.5 — invoices API
6. Phase 2.6 — webapp shell
7. Phase 2.7 — companies UI
8. Phase 2.8 — listings UI
9. Phase 2.9 — invoices UI
10. Phase 2.10 — auth
11. Phase 2.11 — remove mock-test path
12. Phase 2.12 — real-data verification

---

## First slice to execute

**Next correct step:** Phase 2.1 — normalize DB schema.

That is the right foundation. Building frontend first on top of the current `tenants` design would be the wrong order.
