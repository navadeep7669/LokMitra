# LokMitra MVP

LokMitra is a mobile-first, local-first ledger for small businesses. Customer,
order, and confirmed transaction records are stored in merchant-scoped
IndexedDB. Speech recognition and cloud assistance are optional; the typed
workflow remains available without them.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

```powershell
Set-Location D:\Navadeep\udbhav\LokMitra\LokMitra-Frontend
npm ci
Copy-Item .env.example .env
npm run dev
```

In another PowerShell window:

```powershell
npm run build
npm run lint
npm test
```

The anonymous merchant session and direct Supabase sync require
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Turn on anonymous sign-in in
Supabase Auth and apply `../supabase/schema.sql`. The local demo login remains
available when Supabase is not configured. Do not put provider or database
credentials in frontend environment variables.

## Demo

Development demo accounts are shown on the login screen:

- Merchant: `merchant@demo.lokmitra` / `merchant123`
- Developer: `developer@demo.lokmitra` / `developer123`

These are local demo credentials, not production authentication.

## 90-second walkthrough

1. Sign in as the merchant and review the dashboard totals.
2. Open Customers, search, filter by dues/settled, and inspect a profile.
3. Open Voice Ledger, choose an example or type a phrase, edit the review
   fields, then explicitly confirm. Use Undo within 30 seconds to append a
   reversal.
4. Open Ledger, filter by type/date, and export CSV.
5. Open Pending Dues and preview a polite WhatsApp reminder. LokMitra never
   sends it automatically.
6. Move an order through its lifecycle and review Reports.
7. In Settings, change language/read-back options, inspect local sync status,
   and leave cloud consent off unless you intend to use configured cloud
   providers.

## Architecture

- `src/auth/`: demo authentication, role guards, and error boundary.
- `src/data/repository.ts`: merchant-scoped Dexie databases and the only
  application layer allowed to access Dexie.
- `src/domain/`: typed customer/event/order/settings models, integer-paise
  arithmetic, deterministic voice parsing, CSV protection, and report
  aggregation.
- `src/services/`: local translation, reminder URL construction, mock and
  authenticated Supabase sync, cloud ASR/TTS/translation interfaces, and WAV encoding.
- `src/portals/`: merchant and synthetic developer portals.
- `src/i18n.ts`: English, Hindi, and Telugu UI dictionaries. Tenglish voice
  input is supported as a parser option.

Each merchant has a separate `lokmitra_<merchantId>` IndexedDB database with
customers, append-only transaction events, orders, sync outbox, membership,
invoices, and persisted preferences. Ten fictional customers (including
profiles without phone numbers), demo events, and demo orders are seeded
idempotently. Reset requires confirmation and preserves merchant-entered data.

Amounts are stored as integer paise. Balance owed is confirmed credit sales
minus payments received; refunds and payables are reported separately. Event
corrections append a same-customer, same-amount reversal; they never mutate the
original event. Orders and payments have independent lifecycles.

## Supabase and speech services

Frontend variable names:

- `VITE_SUPABASE_URL` — Supabase project URL.
- `VITE_SUPABASE_ANON_KEY` — public anon/publishable key; never use a service-role key.
- `VITE_API_BASE_URL` — optional origin for the authenticated speech API.

Customers, confirmed events, and orders sync directly to Supabase through
merchant-scoped RLS. Dexie remains the offline ledger and outbox; failed
uploads stay queued for retry. The backend exposes authenticated `POST
/api/asr`, `POST /api/tts`, and `POST /api/translate`; Vexyl handles speech
recognition and synthesis, while Sarvam is used for translation only. Cloud
audio requests require consent, connectivity, and a persisted Supabase session.
Speech remains local when consent is off or the device is offline.

See the backend README for backend environment-variable names and setup. Never
put backend/provider secrets in a `VITE_` variable.

## Known limitations

- Supabase RLS and Vexyl inference require a configured project and running
  provider services; they have not been verified against live deployments.
  The RLS integration test is opt-in via `VITE_RUN_SUPABASE_RLS_TESTS=1` and
  should only be run against a dedicated test Supabase project.
- Browser Web Speech implementations may use a browser/cloud service; the app
  cannot guarantee that recognition is offline or disclose the browser's
  provider.
- IndexedDB is local persistence, **not a security boundary**. Merchant
  separation in the browser is an application isolation measure only.
- The deterministic parser has limited coverage; code-mixed Telugu/Hindi
  accuracy needs native-speaker review.
- Sarvam translation quality and live provider connectivity have not been
  verified. Local template translation remains approximate and available
  offline.
- The backend translation API accepts Hindi, Telugu, and English. A Tenglish
  cloud translation request is sent as Hindi; use the local template path for
  Tenglish output.
- Checkout, payment outcomes, invoices, developer metrics, and API-key screens
  are demo surfaces; they do not move money or represent verified billing.
- A service worker supports offline app reload, but cross-device sync requires
  configured Supabase authentication and connectivity.
