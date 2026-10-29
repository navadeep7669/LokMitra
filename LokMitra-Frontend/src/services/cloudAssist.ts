import type { LanguageCode } from '../domain/events';
import type { TranslationService } from './translation';

export type CloudRequestOptions = {
  consent: boolean;
  online: boolean;
  accessToken?: string;
};

export type CloudSpeechProvider = {
  transcribe(audio: Blob, language: LanguageCode, options: CloudRequestOptions): Promise<string>;
};

export type CloudTextToSpeechProvider = {
  synthesize(text: string, language: LanguageCode, options: CloudRequestOptions): Promise<Blob>;
};

export type CloudTranslationProvider = TranslationService & {
  translateCloud(text: string, from: LanguageCode, to: LanguageCode, options: CloudRequestOptions): Promise<string>;
};

type CloudProvidersOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
};

function requestHeaders(token?: string) {
  if (!token) throw new Error('Cloud assistance requires a verified sign-in session.');
  return { Authorization: `Bearer ${token}` };
}

export function createCloudSpeechProvider({ baseUrl = import.meta.env.VITE_API_BASE_URL ?? '', fetcher = fetch }: CloudProvidersOptions = {}): CloudSpeechProvider {
  return {
    async transcribe(audio, language, options) {
      if (!options.consent) throw new Error('Cloud assistance consent is off.');
      if (!options.online) throw new Error('Cloud assistance is unavailable offline.');
      const form = new FormData();
      form.append('file', audio, 'speech.wav');
      form.append('language', language === 'hinglish' ? 'te' : language);
      const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/asr`, {
        method: 'POST',
        headers: requestHeaders(options.accessToken),
        body: form,
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Cloud speech limit reached. Use the typed transcript instead.' : 'Cloud speech is unavailable. Use the typed transcript instead.');
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('transcript' in payload) || typeof payload.transcript !== 'string' || !payload.transcript.trim()) {
        throw new Error('Cloud speech returned an invalid transcript.');
      }
      return payload.transcript;
    },
  };
}

export function createCloudTranslationProvider({ baseUrl = import.meta.env.VITE_API_BASE_URL ?? '', fetcher = fetch }: CloudProvidersOptions = {}): CloudTranslationProvider {
  return {
    translate(text, _from, _to) {
      return { text, approximate: true, provider: 'stub' };
    },
    async translateCloud(text, from, to, options) {
      if (!options.consent) throw new Error('Cloud assistance consent is off.');
      if (!options.online) throw new Error('Cloud assistance is unavailable offline.');
      const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/translate`, {
        method: 'POST',
        headers: { ...requestHeaders(options.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          from_language: from === 'hinglish' ? 'hi' : from,
          to_language: to === 'hinglish' ? 'hi' : to,
        }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Cloud translation limit reached.' : 'Cloud translation is unavailable.');
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('translated_text' in payload) || typeof payload.translated_text !== 'string') {
        throw new Error('Cloud translation returned an invalid response.');
      }
      return payload.translated_text;
    },
  };
}

export function createCloudTextToSpeechProvider({ baseUrl = import.meta.env.VITE_API_BASE_URL ?? '', fetcher = fetch }: CloudProvidersOptions = {}): CloudTextToSpeechProvider {
  return {
    async synthesize(text, language, options) {
      if (!options.consent) throw new Error('Cloud assistance consent is off.');
      if (!options.online) throw new Error('Cloud assistance is unavailable offline.');
      const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/tts`, {
        method: 'POST',
        headers: { ...requestHeaders(options.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: language === 'hinglish' ? 'te' : language }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Cloud speech limit reached.' : 'Speech playback is unavailable.');
      const audio = await response.blob();
      if (!audio.size || !audio.type.toLowerCase().startsWith('audio/wav')) {
        throw new Error('Speech playback returned invalid audio.');
      }
      return audio;
    },
  };
}
