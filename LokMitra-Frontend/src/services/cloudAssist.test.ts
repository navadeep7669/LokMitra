import { describe, expect, it, vi } from 'vitest';
import { createCloudSpeechProvider, createCloudTranslationProvider } from './cloudAssist';
import { encode16kMonoWav } from './wav';

describe('cloud assistance safeguards', () => {
  it('does not make requests when consent is off or the device is offline', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const speech = createCloudSpeechProvider({ fetcher });
    const translation = createCloudTranslationProvider({ fetcher });
    await expect(speech.transcribe(new Blob(['audio']), 'te', { consent: false, online: true, accessToken: 'token' })).rejects.toThrow(/consent is off/i);
    await expect(translation.translateCloud('hello', 'en', 'te', { consent: true, online: false, accessToken: 'token' })).rejects.toThrow(/offline/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces provider errors and rejects malformed provider responses', async () => {
    const failed = createCloudSpeechProvider({ fetcher: vi.fn(async () => new Response(null, { status: 429 })) });
    await expect(failed.transcribe(new Blob(['audio']), 'te', { consent: true, online: true, accessToken: 'token' })).rejects.toThrow(/limit reached/i);
    const invalid = createCloudTranslationProvider({ fetcher: vi.fn(async () => Response.json({ text: 'wrong field' })) });
    await expect(invalid.translateCloud('hello', 'en', 'te', { consent: true, online: true, accessToken: 'token' })).rejects.toThrow(/invalid response/i);
  });

  it('requires a verified token before any network call', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const speech = createCloudSpeechProvider({ fetcher });
    await expect(speech.transcribe(new Blob(['audio']), 'te', { consent: true, online: true })).rejects.toThrow(/verified sign-in/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps Tenglish translation requests to the backend-supported Hindi language code', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ translated_text: 'नमस्ते', provider: 'sarvam_translate' }));
    const provider = createCloudTranslationProvider({ fetcher });
    await provider.translateCloud('hello', 'hinglish', 'hinglish', {
      consent: true, online: true, accessToken: 'token',
    });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as { from_language: string; to_language: string };
    expect(body).toEqual({ text: 'hello', from_language: 'hi', to_language: 'hi' });
  });

  it('sends Tenglish audio with a Telugu language hint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ transcript: 'ఐదు వందలు' }));
    const provider = createCloudSpeechProvider({ fetcher });
    await provider.transcribe(new Blob(['audio']), 'hinglish', {
      consent: true, online: true, accessToken: 'token',
    });
    const body = fetcher.mock.calls[0][1]?.body as FormData;
    expect(body.get('language')).toBe('te');
  });
});

describe('16 kHz mono WAV encoder', () => {
  it('writes a valid PCM header and resamples multichannel input to mono', async () => {
    const channels = [new Float32Array(48_000).fill(0.5), new Float32Array(48_000).fill(-0.5)];
    const buffer = {
      numberOfChannels: 2,
      length: 48_000,
      sampleRate: 48_000,
      getChannelData: (index: number) => channels[index],
    } as AudioBuffer;
    const blob = encode16kMonoWav(buffer);
    const wav = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Could not read WAV data.'));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const view = new DataView(wav);
    const bytes = new Uint8Array(wav);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(32_000);
  });
});
