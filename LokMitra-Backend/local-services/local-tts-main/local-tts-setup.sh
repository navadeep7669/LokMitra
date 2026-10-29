# ============================================================
# 1. INSTALL DEPENDENCIES (run once on your server)
# ============================================================

pip install git+https://github.com/huggingface/parler-tts.git
pip install transformers torch soundfile websockets numpy

# Download the model (cached automatically on first run)
# No HuggingFace login required — model is NOT gated
python3 -c "
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer
print('Downloading ai4bharat/indic-parler-tts...')
model = ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts')
AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts')
AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
print('Download complete.')
"


# ============================================================
# 2. .env ADDITIONS
# ============================================================

# Add to your application .env file:

# Local TTS service Server
LOCAL_TTS_URL=ws://127.0.0.1:8092

# Server config (used by local_tts_server.py)
LOCAL_TTS_HOST=127.0.0.1
LOCAL_TTS_PORT=8092
LOCAL_TTS_DEVICE=auto      # auto detects CUDA/MPS if available, else CPU
LOCAL_TTS_CACHE_SIZE=200    # LRU cache for repeated phrases
LOCAL_TTS_STYLE=default     # default | warm | formal

# To use Local TTS service as primary TTS (full data sovereignty):
# TTS_PROVIDER=local-tts

# To keep Google/ElevenLabs as primary with Local TTS service as fallback:
TTS_PROVIDER=auto


# ============================================================
# 3. PM2 ECOSYSTEM FILE (ecosystem.config.js)
# ============================================================
# Add the server process to your existing PM2 config:

# module.exports = {
#   apps: [
#     {
#       name: 'lokmitra-backend',
#       script: 'server.js',
#       // ... your existing config
#     },
#     {
#       name: 'local-tts',                    // ← ADD THIS
#       script: 'local_tts_server.py',
#       interpreter: 'python3',
#       env: {
#         LOCAL_TTS_HOST:       '127.0.0.1',
#         LOCAL_TTS_PORT:       '8092',
#         LOCAL_TTS_DEVICE:     'auto',
#         LOCAL_TTS_CACHE_SIZE: '200',
#       },
#       restart_delay: 5000,
#       max_restarts: 10,
#       watch: false,
#     }
#   ]
# };


# ============================================================
# 4. START COMMANDS
# ============================================================

# Start server standalone (for testing):
python3 local_tts_server.py

# Add to PM2:
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start on server reboot

# Check status:
pm2 status
pm2 logs local-tts


# ============================================================
# 5. QUICK TEST
# ============================================================

# Test server health:
curl -s http://localhost:8092/health | python3 -m json.tool

# Or test Local TTS service directly:
python3 - <<'EOF'
import asyncio, websockets, json, base64

async def test():
    async with websockets.connect("ws://127.0.0.1:8092") as ws:
        msg = json.loads(await ws.recv())
        print("Server:", msg)  # should be {"type":"ready",...}

        await ws.send(json.dumps({
            "type": "synthesize",
            "text": "നമസ്കാരം, ഇത് ഒരു പരീക്ഷണ സന്ദേശമാണ്.",
            "lang": "ml-IN",
            "style": "default",
            "request_id": "test01"
        }))

        result = json.loads(await ws.recv())
        print(f"Latency: {result['latency_ms']}ms | Cached: {result['cached']}")

        # Save audio to file
        with open("test_malayalam.wav", "wb") as f:
            f.write(base64.b64decode(result['audio_b64']))
        print("Saved test_malayalam.wav")

asyncio.run(test())
EOF
