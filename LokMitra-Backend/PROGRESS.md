# LokMitra progress

## Completed

- Added persisted anonymous Supabase auth for merchants while retaining the
  local demo/developer sign-in when Supabase is not configured.
- Replaced the custom backend sync client with direct Supabase sync using the
  Dexie outbox, server timestamp cursors, idempotent event inserts, and retained
  pending writes on failures.
- Added `supabase/schema.sql` with merchant-scoped RLS, sync cursor indexes,
  timestamp triggers, a backend-only speech quota table, and a trigger that
  protects confirmed event amount, customer, and type fields while allowing
  confirmed-to-voided status changes.
- Configured local STT and TTS services for speech. Sarvam is configured only
  for translation. The backend mounts authenticated `/api/asr`, `/api/tts`, and
  `/api/translate` routes plus `/healthz`.
- Updated environment templates to list variable names with blank assignments.

## Validation

- Frontend: 195 tests passed, 1 optional Supabase RLS test skipped; production
  build and ESLint passed. Vite is responding at `http://127.0.0.1:4173/`.
- Backend: 82 tests passed, 2 optional Postgres tests skipped; Ruff passed.
- Local speech provider request/polling and Sarvam translation requests are covered
  with mocked HTTP. Tests verify Sarvam is the only cloud translation provider.
- Live Supabase two-user RLS, quota integration, and local inference have not
  been verified because no test project or running local services are
  configured.

## Setup notes and limitations

- Enable anonymous sign-in in Supabase Auth and apply `supabase/schema.sql` as
  the database owner. Set a separate password for the restricted
  `lokmitra_pool` login in the Supabase dashboard.
- Configure frontend `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, backend
  JWT verification settings, provider URLs, and the exact CORS origin locally.
- Audio recognition and synthesis require reachable local services. Sarvam
  translation requires its API key. Local/browser speech remains
  available when cloud consent is off or connectivity is unavailable.
- The attachment referenced in the original request could not be opened; local
  service API contracts were taken from the supplied documentation.

## Voice accuracy and customer entry

### Developer portal cleanup

- Removed the Developer portal API keys and API docs navigation entries,
  routes, and mock page components. The mock key generator and one-time key
  display are no longer part of the frontend.
- Removed the corresponding English, Hindi, and Telugu navigation strings.
- Overview remains the default route and the first remaining sidebar entry;
  subscriptions, invoices, and sync inspector remain available.
- Added frontend tests covering the remaining navigation and not-found
  behavior for the removed routes.

### Done

- Added static Hindi, Telugu, and English number lexicons with entries for
  0–100, native/Latin forms, currency vocabulary, Indian multipliers, requested
  Hindi fraction forms, and Telugu half-thousand / hundred-plus-fifty forms.
- Replaced the old partial parser with a backward-compatible `parseVoiceIntent`
  export that recognizes Devanagari, Telugu, Latin, and Western/native digits,
  returns paise integers, surfaces ambiguity, and records confidence/debug
  details. Payment-vs-credit direction cues include recipient/payer markers.
- Added offline Devanagari/Telugu transliteration, phonetic matching, aliases,
  Dexie v3 migration defaults, Supabase customer fields and an idempotent SQL
  migration. The existing RLS policies are unchanged.
- Added the mic-adjacent Telugu/Hindi/English language switch, app-language
  default, persisted input choice, and Telugu (`te-IN`) mapping for Tenglish.
- Replaced voice customer selection with a keyboard-operable searchable
  combobox and inline customer creation. New customers remain local profile
  changes; financial events still require the existing explicit confirmation.
- Added heard/understood confidence chips, a development-only parser debug
  setting, and 64 multilingual amount fixtures with parser and direction tests.

### Native-speaker review required

- Review all Hindi and Telugu 0–100 number spellings and romanization variants
  in `src/domain/numbers/hi.json` and `src/domain/numbers/te.json`.
- Review Hindi/Telugu amount words, currency words, multipliers, and the
  explicitly listed fractional phrases in those lexicons.
- Review credit/payment cue lists and direction markers in
  `src/domain/voice-cues.json`, and transliteration tables in
  `src/domain/transliteration/hi.json` and `src/domain/transliteration/te.json`.
- Review and expand the sample pronunciations in
  `src/domain/__tests__/voice.fixtures.json`; the current synthetic fixtures
  validate code behavior, not native-speaker accuracy.

### Assumptions and unverified items

- When app language is Tenglish/Hinglish, use Telugu recognition (`te-IN`) as
  explicitly requested; the product's persisted speech options remain the
  three native language choices.
- Fuzzy amount matching is limited to one edit for tokens of at least four
  characters and is rejected if the candidate set implies different values.
- Live browser microphone recognition, local STT responses, Supabase customer
  alias sync, and migration execution against a live Supabase project require
  device/service validation and have not been verified here.

## Local speech services and responsive portal

- Renamed the supplied service folders and entrypoints to
  `local-services/local-stt-main` and `local-services/local-tts-main` under the
  backend; backend integration uses `LOCAL_STT_*` and `LOCAL_TTS_*`.
- Kept Sarvam as the only cloud translation provider and retained the existing
  authenticated `/api/asr`, `/api/tts`, and `/api/translate` routes.
- Added offline and Supabase migrations to convert persisted speech usage to
  `local_stt` without discarding existing records.
- Added mobile developer navigation while retaining the same routes and
  desktop sidebar.
- Verified all four developer routes at 360 CSS pixels and 1440 pixels; mobile
  navigation is visible on mobile, the sidebar is retained on laptop, and
  neither viewport has horizontal page overflow.
- Sanitized credential-like values from the backend `.env.example`; rotate any
  credentials that were previously present in that template.
- Upstream license and attribution notices remain in the supplied service
  projects.
- Frontend build and lint pass; 196 tests pass and 1 optional Supabase test is
  skipped. Backend tests pass (86 passed, 2 optional Postgres tests skipped),
  and Ruff excludes the separate local inference service projects.

## API and environment verification

- Provider clients send `X-API-Key` only when their matching local key is
  non-empty; blank and whitespace behavior is covered by provider tests.
- Backend URL defaults use ports 8091 (STT) and 8092 (TTS), matching the
  documented local service ports.
- Live checks are blocked until local `.env` files are configured: Supabase
  URL/anon key, backend database/JWT settings, Sarvam key, and matching local
  service keys. Real local `.env` files and model caches were absent during
  verification. STT model access also needs Hugging Face setup.
- Frontend dev server responds at `http://localhost:5173` and the login page
  loads. Backend and local speech health endpoints are unavailable; dashboard,
  live API, Supabase/RLS, and speech round-trip checks remain unverified.
- Updated example configurations and documented Windows startup commands. No
  real `.env` files were modified.
