# Guesty → myDATA Bridge

Multitenant webhook bridge: λαμβάνει κρατήσεις από **Guesty Pro** και εκδίδει αυτόματα παραστατικά στην **ΑΑΔΕ myDATA** για πολλαπλά ΑΦΜ.

---

## Τι κάνει

- Δέχεται Guesty webhook για `confirmed` / `checked_out` κρατήσεις
- Αντιστοιχεί το `listingId` με το σωστό ΑΦΜ (multitenant)
- Υπολογίζει αυτόματα το **Κλιματικό Τέλος** (εποχή + τύπος ακινήτου)
- Παράγει XML κατά το **myDATA REST API v1.0.9** (invoiceType 11.1)
- Αποστέλλει στην ΑΑΔΕ με τα credentials του κάθε tenant
- Αποθηκεύει MARK, UID, και ιστορικό σε SQLite (migration path → PostgreSQL)
- Idempotency: duplicate webhooks δεν παράγουν διπλό παραστατικό
- HMAC-SHA256 signature validation για κάθε Guesty request

---

## Εγκατάσταση

```bash
# 1. Clone & install
cd /Volumes/AriviaHub02/Repositories/guesty-mydata-bridge
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

## Προσθήκη νέου ΑΦΜ / Tenant

Τρέξε το seed script ή πρόσθεσε απευθείας στη βάση:

```bash
node scripts/add-tenant.js
```

Ή χειροκίνητα στη βάση:

```sql
INSERT INTO tenants (listing_id_guesty, company_name, vat_number, aade_user_id, aade_subscription_key, property_type, invoice_series)
VALUES ('lst_XXXXXXXX', 'Βίλα Αφροδίτη Μ.Ι.Κ.Ε.', '012345678', 'user_api_id', 'subscription_key_here', 'villa', 'A');
```

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
```

Το schema δημιουργείται αυτόματα κατά την εκκίνηση.

---

## Endpoints

| Method | Path | Περιγραφή |
|--------|------|-----------|
| `GET`  | `/health` | Health check |
| `POST` | `/api/webhook/guesty-reservation` | Guesty webhook receiver |

---

## Smoke Test (mock data)

```bash
npm test
```

Τρέχει offline test με mock κράτηση — δεν χρειάζεται σύνδεση στην ΑΑΔΕ.

---

## Κλιματικό Τέλος 2025

| Τύπος | High Season (Μαρ–Οκτ) | Low Season |
|-------|----------------------|------------|
| Βίλα / Μονοκατοικία | €15 / βράδυ | €4 / βράδυ |
| Διαμέρισμα | €10 / βράδυ | €1.50 / βράδυ |

---

## myDATA Endpoints

- **Sandbox:** `https://mydataapidev.aade.gr/SendInvoices`  
- **Production:** `https://mydatapi.aade.gr/myDATA/SendInvoices`
