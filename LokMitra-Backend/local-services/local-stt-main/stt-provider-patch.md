# stt-provider.js Integration Patch
# ===================================
# Apply these 4 changes to your existing stt-provider.js
# Each section shows EXACTLY where to add the new lines.

# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 1 — Add import at the top (after existing requires)
# ──────────────────────────────────────────────────────────────────────────────

# FIND this block (already exists):
const { OpenAISTT, isOpenAISTTConfigured, testOpenAISTT } = require('./openai-stt.js');

# ADD after it:
const { LocalSTT, testLocalSTT, isLocalSTTConfigured } = require('./local-stt-client.js');


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 2 — Add to initializeSTTProvider() function
# ──────────────────────────────────────────────────────────────────────────────

# FIND this block (already exists):
    if (provider === 'openai') {
        const openaiInstance = new OpenAISTT(languageCode);
        return {
            type: 'openai',
            instance: openaiInstance,
            mode: 'batch',
            requiresSilenceDetection: true
        };
    }

# ADD after it:
    if (provider === 'local-stt') {
        const localInstance = new LocalSTT(languageCode);
        return {
            type: 'local-stt',
            instance: localInstance,
            mode: 'stream',             // streaming like Sarvam/Deepgram
            requiresSilenceDetection: false  // server has built-in VAD
        };
    }


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 3 — Add to testAllSTTProviders() function
# ──────────────────────────────────────────────────────────────────────────────

# FIND (already exists):
    const results = {
        sarvam: false,
        groq: false,
        gemini: false,
        deepgram: false,
        openai: false
    };

# REPLACE with:
    const results = {
        sarvam: false,
        groq: false,
        gemini: false,
        deepgram: false,
        openai: false,
        'local-stt': false      // ← add this line
    };

# FIND (near end of testAllSTTProviders, after OpenAI test block):
    return results;

# ADD before it:
    // Test Local STT service server
    if (isLocalSTTConfigured()) {
        try {
            results['local-stt'] = await testLocalSTT();
            console.log(`${results['local-stt'] ? '✅' : '❌'} LocalSTT: ${results['local-stt'] ? 'Server running' : 'Server not reachable'}`);
        } catch (error) {
            console.log(`❌ LocalSTT: Failed - ${error.message}`);
        }
    } else {
        console.log('⚠️  LocalSTT: Not configured');
    }


# ──────────────────────────────────────────────────────────────────────────────
# CHANGE 4 — Add to switchSTTProvider() validation list
# ──────────────────────────────────────────────────────────────────────────────

# FIND (already exists) — the valid providers check:
    const validProviders = ['auto', 'sarvam', 'groq', 'gemini', 'deepgram', 'openai'];

# REPLACE with:
    const validProviders = ['auto', 'sarvam', 'groq', 'gemini', 'deepgram', 'openai', 'local-stt'];
