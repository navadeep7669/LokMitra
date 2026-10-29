# tts-provider.js Integration Patch
# ===================================
# Apply these 4 changes to your existing tts-provider.js
# Each section shows EXACTLY where to add the new lines.

# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 1 — Add import at the top (after existing requires)
# ──────────────────────────────────────────────────────────────────────────────

# FIND this block (already exists):
const { ElevenLabsTTS } = require('./elevenlabs-tts.js');

# ADD after it:
const { getTextToSpeechAudio: localTTSGenerate, testLocalTTS, isLocalTTSConfigured } = require('./local-tts-client.js');


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 2 — Add to getTextToSpeechAudio() switch/if block
# ──────────────────────────────────────────────────────────────────────────────

# FIND (existing block):
    if (provider === 'elevenlabs') {
        ...
    }

# ADD a new block alongside the others:
    if (provider === 'local-tts') {
        const ttsStyle = process.env.LOCAL_TTS_STYLE || 'default';
        const audio = await localTTSGenerate(text, languageCode, { style: ttsStyle });
        return audio;
    }


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 3 — Add to testAllTTSProviders() function
# ──────────────────────────────────────────────────────────────────────────────

# FIND (existing results object):
    const results = {
        google: false,
        azure: false,
        elevenlabs: false,
        ...
    };

# ADD 'local-tts': false to the results object.
# Then FIND (near end, before return results):
    return results;

# ADD before it:
    if (isLocalTTSConfigured()) {
        try {
            results['local-tts'] = await testLocalTTS();
            console.log(`${results['local-tts'] ? '✅' : '❌'} LocalTTS: ${results['local-tts'] ? 'Server running' : 'Not reachable'}`);
        } catch (error) {
            console.log(`❌ LocalTTS: Failed - ${error.message}`);
        }
    } else {
        console.log('⚠️  LocalTTS: Not configured');
    }


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 4 — Add to provider fallback chain / valid providers list
# ──────────────────────────────────────────────────────────────────────────────

# FIND (existing valid providers check):
    const validProviders = ['auto', 'google', 'azure', 'elevenlabs', 'sarvam'];

# REPLACE with:
    const validProviders = ['auto', 'google', 'azure', 'elevenlabs', 'sarvam', 'local-tts'];
