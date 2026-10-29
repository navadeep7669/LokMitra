# LokMitra: Standing Instructions

## Product
LokMitra (लोकमित्र / లోకమిత్ర): voice-first, offline-resilient commerce companion for Indian micro-vendors and freelancers speaking Telugu, Hindi, Tenglish/Hinglish and English. Frontend React PWA, Supabase for cloud data, small backend for AI proxy.

## Workspace and secrets
- Stay inside the workspace. Never print, copy, log or commit secret VALUES; read env variable NAMES only. `.env*` stays in .gitignore.
- Only VITE_-prefixed public variables in the frontend (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE_URL). Provider keys and the Supabase service-role key exist only on the backend.

## Stack
React + Vite + TypeScript (strict, no `any`), Tailwind, lucide-react, react-router-dom, Dexie, @supabase/supabase-js, Vitest + React Testing Library, ESLint.

## Architecture
- Local-first: every core feature works with zero network. Dexie is the offline source of truth; Supabase sync is optional.
- Sync goes frontend → Supabase directly with the signed-in user's token and row-level security. Only the sync service imports the Supabase client; components never do.
- Backend exposes only AI routes: /api/asr and /api/tts (Vexyl STT/TTS via VEXYL_STT_URL and VEXYL_TTS_URL), /api/translate (Bhashini, translation only; Sarvam optional via AI_PROVIDER). Backend verifies the Supabase JWT, keeps keys server-side, applies per-user caps, stores no raw audio, logs no transcripts or amounts. LiveKit is not used.
- Audio or text leaves the device only if online AND the user's cloud-assist consent is ON (default OFF), with a visible "using cloud" indicator. Local template translation is the offline fallback and is labelled "approximate".

## Money
Integer paise only (₹1 = 100 paise), one `money` module for parse/validate/format (Indian grouping). Balance = Σ CONFIRMED CREDIT − Σ CONFIRMED PAYMENT; DRAFT and VOIDED excluded. Never delete a transaction; correct by VOIDED with voidedAt and voidReason behind a confirmation dialog.

## Data model
Customer (id, name, phone?, language?, notes?, aliases: string[], timestamps), Transaction (id, customerId, type CREDIT|PAYMENT, amountPaise, status DRAFT|CONFIRMED|VOIDED, source MANUAL|VOICE, transcript?, note?, createdAt, confirmedAt?, voidedAt?, voidReason?, deviceId, syncStatus), Order (status NEW|IN_PROGRESS|READY|COMPLETED, independent of payment), AppSettings. Dexie schema changes need a version bump with an upgrade function.

## Customer data isolation
One merchant per login. Merchant-level pages (/dashboard, /ledger, /dues, /reports) aggregate only through explicitly named functions. Customer-scoped functions always filter by customerId and throw on a missing id. Customer-facing output (reminders, receipts, per-customer CSV) uses one customer's data only. /customers/:id uses a route guard: validate id, NotFound if absent, id-keyed hooks, ignore stale async results. Cross-merchant isolation is enforced by Supabase RLS and tested with two users. Components never touch Dexie or the network directly.

## Voice rules
- Never save a financial entry silently: input creates a DRAFT in a review card (customer, amount in ₹, type, transcript); only explicit Confirm sets CONFIRMED.
- Parser is deterministic and local, language/script independent (Latin, Devanagari, Telugu). Number words come from data-driven lexicons (hi/te/en), including fractions like डेढ़, ढाई, సవా, రెండున్నర. Ambiguous amount, type or customer must ask the user; never guess or auto-pick.
- Customer matching is cross-script (offline transliteration plus phonetic normalization, ranked candidates with scores). Unknown names offer "Add as new customer"; keyboard entry always available.
- Speech language switch (తెలుగు/हिन्दी/English) is visible, persisted, maps to te-IN/hi-IN/en-IN. Browser speech recognition may use a cloud service and may be unavailable: detect capability and fall back to typed input.
- Show "heard → understood" chips. Speech output obeys a persisted on/off setting.
- Lexicon entries and test fixtures need native-speaker review; list them in PROGRESS.md.

## Safety
CSV: UTF-8 BOM, escape quotes, neutralize leading = + - @. WhatsApp links: https://wa.me/<digits with country code>?text=<encodeURIComponent>; default code 91; disable if no phone. Seed demo data only when empty; reset needs confirmation. IDs via crypto.randomUUID().

## UI
Mobile-first (360px), desktop sidebar plus mobile bottom nav, 48px touch targets, large numerals, icon plus text, high contrast, keyboard operable, aria-live for voice states, prefers-reduced-motion. All UI strings in a typed te/hi/en dictionary. Respectful, non-shaming tone in reminders.

## Working style
Small typed modules, no dead code. After changes run build, lint and tests; fix errors. Keep PROGRESS.md current (done / next / assumptions / unverified / known issues). Phases stop for my review.
