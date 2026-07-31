# Guesty → myDATA Bridge

Multitenant εφαρμογή για ενοικιαζόμενα δωμάτια και τουριστικές κατοικίες που υπάγονται κανονικά σε ΦΠΑ: λαμβάνει κρατήσεις από **Guesty Pro** και εκδίδει παραστατικά στην **ΑΑΔΕ myDATA** για πολλαπλά ΑΦΜ. Δεν εκδίδει «Απόδειξη Βραχυχρόνιας Μίσθωσης».

---

## Τι κάνει

- Δέχεται τα επίσημα Guesty reservation webhooks (`{ event, reservation }`) και εμπλουτίζει ελλιπή payloads μέσω OAuth2/Open API
- Επαναχρησιμοποιεί το Guesty OAuth token μετά από restart μέσω κρυπτογραφημένης αποθήκευσης και PostgreSQL lock (όριο Guesty: 5 tokens/24ωρο)
- Κρυπτογραφεί τα AADE credentials με AES-256-GCM και authenticated context ανά ΑΦΜ/πεδίο, ώστε ciphertext άλλης εταιρείας ή άλλου credential field να απορρίπτεται, με ελεγχόμενη περιστροφή κλειδιού
- Κρατά τελευταίο reservation snapshot και δημιουργεί ΑΑ/XML μόνο στο checkout/ημερήσιο κλείσιμο, ώστε alterations να μην αφήνουν παλιές αξίες
- Ανακτά ξανά το authoritative Guest Folio στο κλείσιμο, περιβάλλει τα invoice items με δύο ίδιες αναγνώσεις reservation/overview για να εντοπίζει alterations εν ώρα ανάγνωσης και υπολογίζει το φορολογητέο gross με εγκεκριμένο, versioned profile ανά `κατάλυμα × platform × source`
- Μπλοκάρει χωρίς δέσμευση ΑΑ κάθε άγνωστο κανάλι, μη εγκεκριμένο profile, άγνωστη/διφορούμενη γραμμή, duplicate item ή calibration mismatch
- Αντιστοιχεί το `listingId` με το σωστό ΑΦΜ (multitenant)
- Υπολογίζει το **Κλιματικό Τέλος** για λειτουργική πληροφόρηση· δεν το ενσωματώνει αυθαίρετα σε 11.x, επειδή η ΑΑΔΕ ορίζει το 8.2 ως χωριστό παραστατικό
- Παράγει ΑΠΥ (`11.2`) ή Τιμολόγιο Παροχής Υπηρεσιών (`2.1`) ανά κατάλυμα/κράτηση, με ΦΠΑ 13%. Τα ΤΑΚ έχουν ανεξάρτητη, ανά κατάλυμα, ρύθμιση και διαβιβάζονται ως `8.2`.
- Επιτρέπει ασφαλές override ΑΠΥ/ΤΠΥ σε μία συγκεκριμένη κράτηση πριν δεσμευτεί ΑΑ, με δική της σειρά και αντισυμβαλλόμενο· μετά το materialization η επιλογή κλειδώνει.
- Δημιουργεί ουρά και την αποστέλλει στο ημερήσιο κλείσιμο με τα κρυπτογραφημένα credentials κάθε εταιρείας
- Υποστηρίζει αυτόματο ημερήσιο scheduler (`DAILY_CLOSE_ENABLED`, ώρα και timezone)
- Το ημερήσιο κλείσιμο χρησιμοποιεί ανανεούμενο database lease: δεύτερο instance αποκλείεται, ενώ ληγμένο lease μετά από crash ανακτάται χωρίς να μπορεί ο παλιός worker να δηλώσει completion
- Πριν από κάθε προγραμματισμένο κλείσιμο εκτελεί Guesty reconciliation. Αν το reconciliation αποτύχει, το κλείσιμο αποτυγχάνει κλειστά για όλες τις εταιρείες και δεν στέλνει τα ήδη staged στοιχεία ως δήθεν πλήρη.
- Οι κρατήσεις που δεν μπορούν να γίνουν stage λόγω άγνωστου/inactive listing ή εταιρείας μένουν σε durable reconciliation inbox. Το cursor μπορεί να προχωρήσει χωρίς να χαθούν: επανελέγχονται στο επόμενο reconciliation ή με ρητό retry endpoint.
- Επιβεβαιώνει κάθε MARK με `RequestTransmittedDocs` χωρίς επαναποστολή όταν αποτύχει μόνο το verification
- Αποθηκεύει MARK, UID, QR URL, cancellation MARK, retries και ιστορικό σε SQLite ή PostgreSQL
- Υποστηρίζει ακύρωση `CancelInvoice` και πιστωτικά `5.1` / `11.4`
- Μετά την επιβεβαίωση MARK αρχειοθετεί ατομικά το ακριβές PDF, SHA-256 και πλήρες issuer/recipient/render snapshot. Το PDF είναι δεσμευμένο στο MARK, δεν αναδημιουργείται από μεταγενέστερο branding και το GET αποτυγχάνει πριν υπάρξει verified archive.
- Το PDF ΤΑΚΚ κρατά immutable snapshot των ποσών υψηλής/χαμηλής περιόδου και εμφανίζει το σωστό ποσό ανά νύχτα όταν μία διαμονή περνά σε άλλη περίοδο
- Μετά από επιτυχημένο `CancelInvoice`, το cancellation MARK επαληθεύεται αυτόματα από το επόμενο ημερήσιο κλείσιμο πριν επιτραπούν νέες υποβολές της ίδιας εταιρείας. Παραμένει διαθέσιμη και χειροκίνητη συμφωνία για uncertain/pending περιπτώσεις.
- Idempotency: duplicate webhooks δεν παράγουν διπλό παραστατικό
- Svix signature validation για τα τρέχοντα Guesty webhooks (και legacy HMAC compatibility)

---

## Εγκατάσταση

```bash
# 1. Clone & install
cd "/Volumes/AriviaHub02/AI AGENTS/CODEX/Guesty-myDATA-Bridge"
npm install

# 2. Config
cp .env.example .env
# Συμπλήρωσε GUESTY_WEBHOOK_SECRET, MYDATA_ENV κλπ.

# 3. Εκκίνηση (development)
npm run dev

# 4. Production
npm start
```

---

## Διαχείριση

Μετά την εκκίνηση άνοιξε `http://localhost:3001/admin`. Η οθόνη επιτρέπει δημιουργία εταιρείας με τα στοιχεία κεφαλίδας PDF και καταλύματος, ρύθμιση ΑΠΥ/ΤΠΥ και ΤΑΚΚ ανά κατάλυμα, ημερήσιο κλείσιμο και λήψη PDF. Το layout είναι branded με κείμενο/στοιχεία εταιρείας, χωρίς αντιγραφή λογοτύπων από τα παραδείγματα.

Το δισέλιδο παράδειγμα `output/pdf/tpy-takk-layout-example.pdf` δείχνει ΤΠΥ 2.1 με 13% ΦΠΑ προς Airbnb Ireland UC και το ξεχωριστό ΤΑΚΚ 8.2 προς τον επισκέπτη. Αναδημιουργείται με `npm run pdf:example`.

Για κατάλυμα που εκδίδει διαφορετικό παραστατικό ανά κανάλι, πρόσθεσε billing rule ανά ακριβές Guesty `platform/source`: π.χ. `manual/manual → 11.2/APY` και `airbnb2/airbnb2 → 2.1/TPY` με στοιχεία Airbnb Ireland UC. Κανόνας που ταιριάζει μόνο στο source δεν εφαρμόζεται.

Ο κανόνας ΑΠΥ/ΤΠΥ είναι ανεξάρτητος από το **profile ποσών**. Για κάθε πραγματικό
`listing/platform/source`, δημιουργείται draft profile με ρητά `include`/`exclude`
selectors για τις γραμμές Guest Folio. Έπειτα εκτελείται calibration με πραγματικά
Guesty reservation IDs και το αναμενόμενο φορολογητέο gross του λογιστή. Μόνο
profile με τουλάχιστον τρία επιτυχημένα δείγματα και κάλυψη κάθε selector μπορεί
να εγκριθεί. Broad `include` μόνο με `normalType` δεν εγκρίνεται: κάθε γραμμή που
μπαίνει στο φορολογητέο ποσό χρειάζεται σταθερό discriminator από το πραγματικό
Guest Folio. No-show, split/relocated και multi-listing κρατήσεις δεν γίνονται
δεκτές ως calibration samples. Η έγκριση είναι
immutable· αλλαγή κανόνων γίνεται με νέα έκδοση και αναστέλλει την παλιότερη.

Δεν χρησιμοποιούνται αυτόματα `hostPayout`, commissions, `nightsSubtotal`,
adjustments ή deduction flags. Το ποσό προκύπτει μόνο από το τελικό
`invoiceItems[].totalPrice` των ρητά εγκεκριμένων γραμμών. Οι τιμές πλήρους
ακρίβειας αθροίζονται πρώτα και το τελικό gross στρογγυλοποιείται μία φορά σε
λεπτά· δεν στρογγυλοποιείται κάθε Guesty line item χωριστά.

### Αρχικοποίηση ποσών ανά κανάλι

Δεν υπάρχει κοινός κανόνας ποσού για όλα τα κανάλια και δεν γίνεται αντιστοίχιση
με βάση την ονομασία τους. Για κάθε κατάλυμα καταγράφονται τα ακριβή
`platform/source` που επιστρέφει ο λογαριασμός Guesty και αρχικοποιούνται
ανεξάρτητα profiles, ενδεικτικά για:

- Airbnb: accommodation/VAT, Resolution Center και κρατήσεις/προμήθειες που
  εμφανίζονται ως χωριστές γραμμές.
- Booking.com: room/fees/VAT, city/local taxes και commission σύμφωνα με το
  πραγματικό Guest Folio του συγκεκριμένου καταλύματος.
- Guesty Booking Engine: room, VAT, discounts, coupons και processing fees,
  χωρίς δεύτερη εφαρμογή adjustment ή deduction.
- Κάθε άλλο OTA ή direct/manual source: δικό του profile· δεν κληρονομεί τους
  κανόνες Airbnb ή Booking.com.

Η αρχικοποίηση ολοκληρώνεται μόνο με πραγματικά δείγματα που συμφωνούν με το
φορολογητέο gross που επιβεβαιώνει ο λογιστής. Νέο κανάλι, νέα ή μετονομασμένη
γραμμή, αλλαγή νομίσματος, split/relocation, no-show ή απόκλιση calibration
στέλνει την κράτηση σε review και δεν δημιουργεί παραστατικό ή ΑΑ.

Το `platform/source` δεν πρέπει να συμπληρώνεται από υπόθεση ή εμπορική ονομασία.
Καταγράφεται από πραγματική κράτηση του συγκεκριμένου Guesty account. Επομένως
Booking.com, Airbnb, κάθε άλλο OTA/direct source και το Guesty Booking Engine
αρχικοποιούνται χωριστά για κάθε listing, ακόμη και όταν εμφανίζουν παρόμοιες
γραμμές ή ίδιο τελικό ποσό.

---

## Migration SQLite → PostgreSQL

Άλλαξε μόνο στο `.env`:

```env
DB_CLIENT=pg
DB_HOST=localhost
DB_PORT=5432
DB_NAME=guesty_mydata
DB_USER=postgres
DB_PASSWORD=your_password
DB_POOL_MAX=10
```

Το schema δημιουργείται αυτόματα κατά την εκκίνηση. Το PostgreSQL pool πρέπει
να έχει τουλάχιστον δύο connections, επειδή η migration κρατά dedicated
advisory-lock connection. Σε upgrade γίνεται επίσης reconciliation των sequence
rows με το μεγαλύτερο ήδη εκδομένο ΑΑ, ώστε να μη γίνει επαναχρησιμοποίηση.

Το πραγματικό PostgreSQL contract ελέγχεται στο CI με PostgreSQL 16 μέσω
`npm run test:postgres`· η εντολή επιτρέπεται να καθαρίσει μόνο τη dedicated
βάση με όνομα `guesty_mydata_test`.

---

## Endpoints

| Method | Path | Περιγραφή |
|--------|------|-----------|
| `GET`  | `/health` | Health check |
| `POST` | `/api/webhook/guesty-reservation` | Guesty webhook receiver |
| `POST` | `/api/daily-close` | Αποστολή εκκρεμών παραστατικών έως business date |
| `GET` | `/api/daily-close-runs` | Ιστορικό κλεισιμάτων και αποτελεσμάτων |
| `GET` | `/api/fiscal-documents` | Κατάλογος παραστατικών και MARK |
| `GET` | `/api/fiscal-documents/:id/pdf` | Ακριβές archived PDF μόνο μετά από verified MARK/archive |
| `POST` | `/api/fiscal-documents/:id/cancel` | Πλήρης ακύρωση |
| `POST` | `/api/fiscal-documents/:id/credit` | Δημιουργία πιστωτικού |
| `POST` | `/api/fiscal-documents/:id/reconcile-mark` | Συμφωνία αβέβαιης διαβίβασης με επιβεβαιωμένο MARK |
| `POST` | `/api/fiscal-documents/:id/reconcile-cancellation` | Συμφωνία αβέβαιης ακύρωσης με cancellation MARK |
| `POST` | `/api/fiscal-documents/:id/resolve-cancellation-failure` | Audited επίλυση οριστικής απόρριψης CancelInvoice μετά από νέο έλεγχο ΑΑΔΕ |
| `GET` | `/api/fiscal-documents/:id/cancellation-resolution-events` | Append-only ιστορικό αποφάσεων ακύρωσης |
| `GET` | `/api/reservations?requires_review=true` | Μεταβολές μετά τη δημιουργία παραστατικών |
| `PATCH` | `/api/reservations/:id/fiscal-override` | Εξαίρεση ΑΠΥ/ΤΠΥ πριν από τη δημιουργία ΑΑ |
| `DELETE` | `/api/reservations/:id/fiscal-override` | Επιστροφή στον κανόνα καναλιού πριν από τη δημιουργία ΑΑ |
| `POST` | `/api/reservations/:id/reopen-for-reissue` | Νέα revision μετά την ακύρωση όλων των προηγούμενων παραστατικών |
| `POST` | `/api/reservations/:id/resolve-cancellation` | Κλείσιμο ελέγχου ακύρωσης όταν όλα τα παραστατικά έχουν ακυρωθεί |
| `POST` | `/api/connections/guesty/test` | Read-only Guesty authenticated API test |
| `POST` | `/api/connections/guesty/reconcile` | Paginated backfill για χαμένα webhooks με persistent cursor |
| `GET` | `/api/connections/guesty/reconciliation-inbox?status=unresolved` | Durable inbox/DLQ για unmapped/inactive κρατήσεις και αποτυχίες κατά το retry τους |
| `POST` | `/api/connections/guesty/reconciliation-inbox/retry` | Επανέλεγχος όλων των unresolved inbox entries μετά τη διόρθωση mapping/Guesty |
| `POST` | `/api/companies/:id/mydata-connection/test` | Read-only myDATA credential test |
| `GET/POST` | `/api/financial-profiles` | Κατάλογος και νέα versioned profiles ποσών |
| `PATCH` | `/api/financial-profiles/:id` | Ενημέρωση μόνο draft profile |
| `POST` | `/api/financial-profiles/:id/calibrate` | Calibration με πραγματική Guesty κράτηση |
| `POST` | `/api/financial-profiles/:id/approve` | Έγκριση μετά τα απαιτούμενα επιτυχημένα δείγματα |
| `POST` | `/api/financial-profiles/:id/suspend` | Άμεσο μπλοκάρισμα ενεργού profile |
| `GET` | `/api/financial-channels/observed` | Παρατηρημένοι συνδυασμοί listing/platform/source |
| `GET/POST` | `/api/sandbox-signoffs` | Αμετάβλητη έγκριση verified κύριου + ΤΑΚΚ και hashes PDF |
| `GET` | `/api/sandbox-acceptance/requirements` | Capability matrix sandbox ανά εταιρεία |
| `GET/POST` | `/api/sandbox-acceptance/runs` | Immutable λογιστική έγκριση sandbox evidence |
| `GET` | `/api/readiness` | Συνολικό sandbox/production preflight |
| `GET` | `/api/readiness?company_id=:id` | Tenant-scoped preflight· πρόβλημα άλλου ΑΦΜ δεν μπλοκάρει την υποβολή της εταιρείας |

---

## Smoke Test (mock data)

```bash
npm test
npm run test:xsd
```

Τα tests τρέχουν offline και δεν στέλνουν στην ΑΑΔΕ. Το `test:xsd` ελέγχει όλους τους παραγόμενους τύπους απέναντι στην επίσημη production v2.0.1 και στη νεότερη preofficial sandbox v2.0.2 της ΑΑΔΕ, που βρίσκονται στο `docs/aade-xsd`.

---

## ΤΑΚΚ

Το ποσό και η κατηγορία `otherTaxesPercentCategory` ορίζονται υποχρεωτικά ανά κατάλυμα και περίοδο. Νέο κατάλυμα χωρίς ποσά υψηλής/χαμηλής περιόδου και τις αντίστοιχες κατηγορίες ΑΑΔΕ απορρίπτεται.

Για το συγκεκριμένο portfolio δεν επιτρέπονται οι κατηγορίες βραχυχρόνιας μίσθωσης `25/26/28/29`. Η εφαρμογή χρησιμοποιεί `24` (υψηλή) και `10` (χαμηλή) για ενοικιαζόμενα δωμάτια/διαμερίσματα ή `27` (υψηλή) και `30` (χαμηλή) για αυτοεξυπηρετούμενες τουριστικές επιπλωμένες βίλες. Τα χρηματικά ποσά παραμένουν ρητή ρύθμιση ανά κατάλυμα.

---

## myDATA Endpoints

- **Sandbox:** `https://mydataapidev.aade.gr/SendInvoices`  
- **Production:** `https://mydatapi.aade.gr/myDATA/SendInvoices`

## Πριν από production

Διάβασε και ολοκλήρωσε το [myDATA v2.0.1 readiness baseline](docs/mydata-v2.0.1-readiness.md). Το production circuit breaker απαιτεί ρητά `MYDATA_PRODUCTION_ENABLED=true`, πέρα από `MYDATA_ENV=production`.

### Εξωτερικές προϋποθέσεις και σημερινά όρια

Το repository δεν αποτελεί από μόνο του production ενεργοποίηση. Απαιτούνται
πραγματικά Guesty OAuth/webhook credentials, ανά-εταιρεία production credentials
ΑΑΔΕ, δημόσιο HTTPS endpoint, PostgreSQL με επιβεβαιωμένα backups/restore,
πραγματικό Guesty calibration ανά `listing/platform/source` και λογιστική
έγκριση sandbox evidence για όλες τις οικογένειες παραστατικών.

Σήμερα δεν παρέχονται ακόμη αποστολή PDF με email ή Guesty messaging, delivery
outbox/bounce tracking, χρήστες/RBAC ανά εταιρεία, εξωτερικό durable scheduler,
αυτόματα off-site backups ή ολοκληρωμένα metrics/alerts. Το admin API
προστατεύεται από ένα κοινό bearer token και ο scheduler τρέχει μέσα στο μοναδικό
web process. Αυτά είναι ρητά production-operability gaps και όχι ολοκληρωμένες
δυνατότητες.

## Deployment

Το repository περιλαμβάνει production Docker image, PostgreSQL Compose stack,
Render Blueprint, DB-aware readiness checks και graceful shutdown. Η πρώτη
εγκατάσταση γίνεται υποχρεωτικά σε myDATA sandbox, με μία μόνο app instance και
απενεργοποιημένο ημερήσιο scheduler.

Δες το πλήρες [deployment, backup και rollback runbook](docs/deployment-runbook.md).
Το production preflight απαιτεί immutable, λογιστικά εγκεκριμένο sandbox evidence
ανά εταιρεία για κάθε οικογένεια που χρησιμοποιεί: `2.1+8.2` και `5.1`, ή/και
`11.2+8.2` και `11.4`, καθώς και `CancelInvoice` με cancellation MARK
επαληθευμένο από `RequestTransmittedDocs`. Η έγκριση δεσμεύεται στο ΑΦΜ, στα
τρέχοντα AADE credentials και στην έκδοση του fiscal contract.
