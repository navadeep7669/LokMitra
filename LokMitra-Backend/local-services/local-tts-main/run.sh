#!/bin/bash
# Start the Local TTS service server
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment config
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

source venv/bin/activate
python3 local_tts_server.py
