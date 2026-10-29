# ============================================================
# 1. INSTALL DEPENDENCIES (run once on your server)
# ============================================================

pip install transformers torchaudio torch websockets numpy

# Download the model (cached to ~/.cache/huggingface)
python -c "
from transformers import AutoModel
print('Downloading ai4bharat/indic-conformer-600m-multilingual...')
model = AutoModel.from_pretrained('ai4bharat/indic-conformer-600m-multilingual', trust_remote_code=True)
print('Download complete.')
"


# ============================================================
# 2. .env ADDITIONS
# ============================================================

# Add to your application .env file:

# Local STT service Server
LOCAL_STT_URL=ws://127.0.0.1:8091

# Server config (used by local_stt_server.py)
LOCAL_STT_HOST=127.0.0.1
LOCAL_STT_PORT=8091
LOCAL_STT_DECODE=ctc       # ctc = ~150ms faster | rnnt = more accurate
LOCAL_STT_DEVICE=auto      # auto detects CUDA if available, else CPU

# To use Local STT service as primary STT (full data sovereignty):
# STT_PROVIDER=local-stt

# To keep Sarvam as primary with Local STT service as fallback:
STT_PROVIDER=auto


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
#       name: 'local-stt',                    // ← ADD THIS
#       script: 'local_stt_server.py',
#       interpreter: 'python3',
#       env: {
#         LOCAL_STT_HOST:   '127.0.0.1',
#         LOCAL_STT_PORT:   '8091',
#         LOCAL_STT_DECODE: 'ctc',
#         LOCAL_STT_DEVICE: 'auto',
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
python3 local_stt_server.py

# Add to PM2:
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start on server reboot

# Check status:
pm2 status
pm2 logs local-stt


# ============================================================
# 5. QUICK TEST
# ============================================================

# Test server is running:
curl -s http://localhost:8081/test-stt | python3 -m json.tool

# Or test Local STT service directly with a WAV file:
python3 - <<'EOF'
import asyncio, websockets, json, wave, numpy as np

async def test():
    async with websockets.connect("ws://127.0.0.1:8091") as ws:
        msg = json.loads(await ws.recv())
        print("Server:", msg)  # should be {"type":"ready",...}

        await ws.send(json.dumps({"type":"start","lang":"ml-IN","session_id":"test01"}))
        msg = json.loads(await ws.recv())
        print("Started:", msg)

        # Load a test WAV file (16kHz mono)
        with wave.open("test-audio.wav", "rb") as wf:
            audio = wf.readframes(wf.getnframes())
        await ws.send(audio)

        await ws.send(json.dumps({"type":"stop"}))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            print("Result:", msg)
            if msg["type"] == "stopped":
                break

asyncio.run(test())
EOF
