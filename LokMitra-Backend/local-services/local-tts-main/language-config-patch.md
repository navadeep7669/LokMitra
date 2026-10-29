# language-config.js Patch
# =========================
# Add 'local-tts' as a preferred or fallback TTS provider for Indian languages.
# This makes Local TTS service available for all Indian language calls.

# ──────────────────────────────────────────────────────────────────────────────
# CHANGE — Update each Indian language entry to include 'local-tts'
# ──────────────────────────────────────────────────────────────────────────────

# FIND (ml-IN entry, already exists):
    'ml-IN': {
        name: 'Malayalam',
        nativeName: 'മലയാളം',
        ttsProviders: ['google'],
        preferredTTS: 'google',
        ...
    }

# REPLACE with:
    'ml-IN': {
        name: 'Malayalam',
        nativeName: 'മലയാളം',
        ttsProviders: ['google', 'local-tts'],
        preferredTTS: 'local-tts',        # Use local TTS as primary
        fallbackTTS:  'google',            # Keep Google as fallback
        ttsStyle:     'default',           # or 'warm' for healthcare
        ...
    }

# Apply the same pattern for all Indian language entries:
#   hi-IN, ta-IN, te-IN, kn-IN, bn-IN, gu-IN, mr-IN, pa-IN, or-IN, as-IN, ur-IN

# ──────────────────────────────────────────────────────────────────────────────
# OPTIONAL — For full data sovereignty deployments, set as primary:
# ──────────────────────────────────────────────────────────────────────────────
# Set TTS_PROVIDER=local-tts in .env
# OR change preferredTTS: 'local-tts' for specific languages
# This routes ALL Indian language calls through the local model, zero API cost.
