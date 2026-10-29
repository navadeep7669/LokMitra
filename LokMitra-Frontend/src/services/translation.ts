import type { LanguageCode } from '../domain/events';

export interface TranslationService {
  translate(text: string, from: LanguageCode, to: LanguageCode): { text: string; approximate: true; provider: 'local' | 'stub' };
}
const phrases: Record<string, Partial<Record<LanguageCode, string>>> = {
  payment: { en: 'payment received', hi: 'भुगतान प्राप्त हुआ', te: 'చెల్లింపు అందింది', hinglish: 'payment receive hua' },
  credit: { en: 'credit given', hi: 'उधार दिया', te: 'అప్పుగా ఇచ్చారు', hinglish: 'credit diya' },
  pending: { en: 'pending balance', hi: 'बाकी राशि', te: 'బాకీ మొత్తం', hinglish: 'pending balance' },
  thankyou: { en: 'thank you', hi: 'धन्यवाद', te: 'ధన్యవాదాలు', hinglish: 'thank you' },
};
const numberWords: Record<string, Partial<Record<LanguageCode, string>>> = {
  one: { hi: 'एक', te: 'ఒకటి', hinglish: 'one' }, two: { hi: 'दो', te: 'రెండు', hinglish: 'two' },
  three: { hi: 'तीन', te: 'మూడు', hinglish: 'three' }, four: { hi: 'चार', te: 'నాలుగు', hinglish: 'four' },
  five: { hi: 'पाँच', te: 'ఐదు', hinglish: 'five' }, ten: { hi: 'दस', te: 'పది', hinglish: 'ten' },
  hundred: { hi: 'सौ', te: 'వంద', hinglish: 'hundred' }, thousand: { hi: 'हज़ार', te: 'వేలు', hinglish: 'thousand' },
  rupees: { hi: 'रुपये', te: 'రూపాయలు', hinglish: 'rupees' }, pending: { hi: 'बाकी', te: 'బాకీ', hinglish: 'pending' },
  payment: { hi: 'भुगतान', te: 'చెల్లింపు', hinglish: 'payment' }, received: { hi: 'मिला', te: 'వచ్చింది', hinglish: 'receive hua' },
};
export const localTranslationService: TranslationService = {
  translate(text, _from, to) {
    const key = text.trim().toLowerCase();
    const entry = phrases[key];
    if (entry?.[to]) return { text: entry[to]!, approximate: true, provider: 'local' };
    let replaced = false;
    const translated = text.replace(/[\p{L}]+/gu, (word) => {
      const replacement = numberWords[word.toLowerCase()]?.[to];
      if (replacement) replaced = true;
      return replacement ?? word;
    });
    return { text: translated, approximate: true, provider: replaced ? 'local' : 'stub' };
  },
};
export const cloudTranslationStub: TranslationService = {
  translate(text) { return { text, approximate: true, provider: 'stub' }; },
};
