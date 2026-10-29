# LokMitra backend

The FastAPI backend verifies Supabase access tokens and exposes only the speech
and translation services. Customer, event, and order sync happens directly
between the frontend and Supabase under row-level security (RLS).

## Setup

- Python 3.11+
- Supabase project with anonymous sign-in enabled
- Local STT and TTS services for cloud speech
- Optional Sarvam translation API key

The STT and TTS projects are in `local-services/local-stt-main` and
`local-services/local-tts-main`. Start each service locally on port 8091 and
8092 respectively; the backend calls those endpoints through `LOCAL_STT_URL`
and `LOCAL_TTS_URL`.

Copy `.env.example` to `.env` and fill in the required values. The example
contains no credential values. Configure either
`SUPABASE_JWT_SECRET` or `SUPABASE_JWKS_URL`, plus `SUPABASE_JWT_ISSUER`,
`DATABASE_URL`, and an exact `CORS_ORIGINS` allowlist. For Supabase JWT
verification, use its signing secret/JWKS—not the database password, anon key,
secret API key, or service-role key. Keep all credentials server-side.

The `lokmitra_pool` PostgreSQL login is used only for per-user speech quotas.
Apply `../supabase/schema.sql` as the project database owner, then set a
separate password for `lokmitra_pool` in Supabase **Database → Roles** and use
that role in `DATABASE_URL`. Use the exact host, port, and username format from
the Supabase Connect dialog. The role has no RLS bypass and is restricted to
quota rows scoped by the authenticated user ID.

## Run locally (Windows PowerShell)

Before starting, copy each `.env.example` to `.env` and fill in required values
in your editor. Keep the Supabase anon key in the frontend environment only;
never put the service-role key there. For local speech authentication, configure
the same optional STT/TTS key in both the matching backend and service
environment files. Install dependencies and download models before startup;
the first downloads can take several gigabytes and may take a long time. STT
requires approved Hugging Face access and `HF_TOKEN`. The upstream service
READMEs list macOS/Linux prerequisites, so Windows inference setup is
unverified; use their documented environment if the PowerShell setup fails.

Example dependency setup from the workspace root:

```powershell
# STT (use Python 3.10+ and configure HF_TOKEN in its local .env first)
Set-Location .\LokMitra-Backend\local-services\local-stt-main
py -3.10 -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip
.\venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.\venv\Scripts\python.exe -m pip install -r requirements.txt
Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process') } }
.\venv\Scripts\python.exe -c "from transformers import AutoModel; AutoModel.from_pretrained('ai4bharat/indic-conformer-600m-multilingual', trust_remote_code=True)"

# TTS
Set-Location ..\local-tts-main
py -3.10 -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip
.\venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -c "from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; model = ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)"
Set-Location ..\..\..
```

Use four separate PowerShell terminals, starting from the workspace root:

1. STT:

   ```powershell
   Set-Location .\LokMitra-Backend\local-services\local-stt-main
   Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process') } }
   $env:PORT = '8091'
   .\venv\Scripts\python.exe .\local_stt_server.py
   ```

2. TTS:

   ```powershell
   Set-Location .\LokMitra-Backend\local-services\local-tts-main
   Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process') } }
   $env:PORT = '8092'
   .\venv\Scripts\python.exe .\local_tts_server.py
   ```

3. Backend:

   ```powershell
   Set-Location .\LokMitra-Backend
   .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
   ```

4. Frontend:

   ```powershell
   Set-Location .\LokMitra-Frontend
   npm run dev -- --host localhost --port 5173
   ```

Open `http://localhost:5173`. STT and TTS health endpoints are `/health` on
ports 8091 and 8092; the backend health endpoint is
`http://127.0.0.1:8000/healthz`. The frontend example points authenticated AI
requests at the local backend. Supabase sign-in, cloud AI, and RLS checks need
configured credentials and services; demo mode remains available offline.

## Providers

- `LOCAL_STT_URL` defaults to `http://127.0.0.1:8091`; optional
  `LOCAL_STT_API_KEY` is sent as `X-API-Key`. The backend submits audio to
  `/batch/transcribe` and polls `/batch/result/{job_id}`.
- `LOCAL_TTS_URL` defaults to `http://127.0.0.1:8092`; optional
  `LOCAL_TTS_API_KEY` is sent as `X-API-Key`. The backend submits synthesis
  requests to `/batch/synthesize` and polls the same result route.
- `SARVAM_API_KEY` and optional `SARVAM_TRANSLATE_URL` configure text
  translation only. Sarvam is not used for transcription or speech synthesis.
  The provider sends source/target locale codes and uses Sarvam's `mayura:v1`
  translation model.

Audio and text are validated and sent to the configured provider without being
persisted. Provider errors return a sanitized service-unavailable response.
Daily quotas are per authenticated Supabase user; rate limits also apply.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness |
| POST | `/api/asr` | Multipart audio (`file`, optional `language`: `te`, `hi`, `en`) |
| POST | `/api/tts` | JSON `{ "text": "...", "language": "te" }`; returns WAV |
| POST | `/api/translate` | Sarvam translation JSON `{ "text": "...", "from_language": "en", "to_language": "te" }` |

All three AI routes require a valid Supabase bearer token. No backend sync,
ledger, merchant-profile, or speech-parser routes are mounted.

## Development checks

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\ruff.exe check .
```

Provider tests use mocked HTTP responses. Live Supabase RLS, database quota
concurrency, and local speech inference require configured services and are not
validated by unit tests. Optional Postgres integration tests use
`TEST_DATABASE_URL` against a dedicated database with `../supabase/schema.sql`
already applied.
