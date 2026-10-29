import { describe, expect, it, vi } from 'vitest';
import { createWebSpeechProvider, recognitionLanguageFor, type RecognitionEngine } from './speech';

function makeEngine(): RecognitionEngine {
  return { lang: '', interimResults: true, onresult: null, onerror: null, onend: null, start: vi.fn(), stop: vi.fn() };
}

describe('browser speech provider', () => {
  it.each([
    ['en', 'en-IN'],
    ['hi', 'hi-IN'],
    ['te', 'te-IN'],
    ['hinglish', 'te-IN'],
  ] as const)('maps %s to the correct recognition language', (language, expected) => {
    expect(recognitionLanguageFor(language)).toBe(expected);
  });

  it('detects an unsupported browser and reports the typed fallback', async () => {
    const provider = createWebSpeechProvider(() => undefined);
    expect(provider.isSupported()).toBe(false);
    await expect(provider.listen('te-IN')).rejects.toThrow(/not supported/i);
  });

  it('returns a transcript using the configured language', async () => {
    const engine = makeEngine();
    const provider = createWebSpeechProvider(() => engine);
    const result = provider.listen('te-IN');
    expect(engine.lang).toBe('te-IN');
    engine.onresult?.({ results: [[{ transcript: 'Ravi nunchi 500 vachayi' }]] });
    await expect(result).resolves.toBe('Ravi nunchi 500 vachayi');
  });

  it('surfaces microphone permission errors', async () => {
    const engine = makeEngine();
    const provider = createWebSpeechProvider(() => engine);
    const result = provider.listen('en-IN');
    engine.onerror?.({ error: 'not-allowed' });
    await expect(result).rejects.toThrow(/permission was denied/i);
  });

  it('explains when browser speech recognition cannot connect', async () => {
    const engine = makeEngine();
    const provider = createWebSpeechProvider(() => engine);
    const result = provider.listen('en-IN');
    engine.onerror?.({ error: 'network' });
    await expect(result).rejects.toThrow(/could not connect/i);
  });
});
