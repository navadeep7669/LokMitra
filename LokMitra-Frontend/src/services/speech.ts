import type { LanguageCode } from '../domain/events';

type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechErrorEvent = { error: string };
export type RecognitionEngine = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
export type SpeechProvider = {
  isSupported(): boolean;
  listen(language: string): Promise<string>;
};

export function recognitionLanguageFor(language: LanguageCode): string {
  switch (language) {
    case 'te':
      return 'te-IN';
    case 'hi':
      return 'hi-IN';
    case 'hinglish':
      return 'te-IN';
    case 'en':
      return 'en-IN';
  }
}

function speechErrorMessage(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was denied.';
    case 'audio-capture':
      return 'No microphone was detected or it is unavailable.';
    case 'no-speech':
      return 'No speech was detected.';
    case 'network':
      return 'Speech recognition could not connect. Check your internet connection or try typed input.';
    default:
      return 'Speech recognition failed. Try typed input instead.';
  }
}

function browserRecognitionEngine(): RecognitionEngine | undefined {
  const speechWindow = window as Window & {
    SpeechRecognition?: new () => RecognitionEngine;
    webkitSpeechRecognition?: new () => RecognitionEngine;
  };
  const Constructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  return Constructor ? new Constructor() : undefined;
}

export function createWebSpeechProvider(
  getEngine: () => RecognitionEngine | undefined = browserRecognitionEngine,
): SpeechProvider {
  return {
    isSupported: () => getEngine() !== undefined,
    listen(language) {
      const recognition = getEngine();
      if (!recognition) return Promise.reject(new Error('Speech input is not supported in this browser.'));
      return new Promise((resolve, reject) => {
        recognition.lang = language;
        recognition.interimResults = false;
        let settled = false;
        recognition.onresult = (event) => {
          if (settled) return;
          settled = true;
          const transcript = event.results[0]?.[0]?.transcript;
          if (typeof transcript !== 'string' || !transcript.trim()) {
            reject(new Error('Speech recognition returned an empty transcript.'));
            return;
          }
          resolve(transcript);
        };
        recognition.onerror = (event) => {
          if (settled) return;
          settled = true;
          reject(new Error(speechErrorMessage(event.error)));
        };
        recognition.onend = () => {
          if (settled) return;
          settled = true;
          reject(new Error('Speech recognition ended without a transcript.'));
        };
        try {
          recognition.start();
        } catch {
          settled = true;
          reject(new Error('Could not start speech recognition.'));
        }
      });
    },
  };
}
