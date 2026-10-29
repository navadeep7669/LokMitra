# LokMitra integration status

## Frontend

- React/Vite/TypeScript merchant and developer portals remain in
  `LokMitra-Frontend`.
- Dexie provides the offline ledger, preferences, and retryable sync outbox.
- Merchant auth uses persisted anonymous Supabase sessions when configured;
  local demo auth remains available without Supabase.
- Customer, event, and order sync goes directly to Supabase. Row-level security
  scopes each record to its authenticated merchant.
- Browser speech remains a local option. Cloud assist uses local STT/TTS and
  Sarvam translation with consent and connectivity checks.

## Backend

- FastAPI mounts `/healthz`, `/api/asr`, `/api/tts`, and `/api/translate`.
- Every AI route requires a verified Supabase bearer token and has rate and
  per-user daily quota limits.
- The local services handle transcription and synthesis. Sarvam is
  translation-only.
- The backend does not expose customer/order sync, ledger, merchant profile,
  or speech parsing routes.
- Apply `../supabase/schema.sql` to a dedicated Supabase project for direct
  client sync, RLS, confirmed event protections, and server-side AI quotas.

## Validation and outstanding work

- Frontend tests/build/lint and backend tests/lint are run locally; exact
  results are recorded in `PROGRESS.md`.
- Provider tests use mocked responses. Real local speech inference, live Sarvam
  translation, Supabase RLS isolation, and Postgres quota concurrency require
  credentials/services and have not been verified.
- Configure frontend Supabase URL/anon key, backend JWT settings, provider
  URLs/credentials, and exact CORS origins locally. Never expose database,
  provider, or Supabase service-role credentials in frontend variables.
- The original referenced attachment was unavailable; the local service API
  contracts were taken from the supplied service documentation.
