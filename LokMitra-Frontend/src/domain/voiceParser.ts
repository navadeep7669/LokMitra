import english from './numbers/en.json';
import hindi from './numbers/hi.json';
import telugu from './numbers/te.json';
import cues from './voice-cues.json';
import { matchCustomerCandidates, type RankedCustomer } from './customerMatching';
import { MAX_AMOUNT_PAISE, rupeesToPaise } from './money';
import type { Customer } from './events';
import { transliterate } from './transliteration';

type LexiconEntry = { value: number; forms: string[] };
type NumberLexicon = { entries: LexiconEntry[]; multipliers: LexiconEntry[]; fractions: LexiconEntry[]; currency: string[] };
type NumberToken = { text: string; start: number; end: number; index: number };
type AmountLexeme = { kind: 'number' | 'multiplier' | 'fraction'; value: number; fuzzy: boolean; form: string };
type AmountResult = { paise: number | null; confidence: number; heard: string; ambiguous: boolean; matched: string[]; customerQuery: string };
type LexiconMatch = { lexeme: AmountLexeme; length: number };

const numberLexicons: NumberLexicon[] = [english, hindi, telugu];
const digitMap: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
  '౦': '0', '౧': '1', '౨': '2', '౩': '3', '౪': '4', '౫': '5', '౬': '6', '౭': '7', '౮': '8', '౯': '9',
};
const phraseIndex = new Map<string, AmountLexeme[]>();
const currencyForms = new Set<string>();

function normalizePhrase(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[०-९౦-౯]/g, (digit) => digitMap[digit] ?? digit)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function addPhrase(form: string, lexeme: AmountLexeme): void {
  const normalized = normalizePhrase(form);
  if (!normalized) return;
  const existing = phraseIndex.get(normalized) ?? [];
  if (!existing.some((item) => item.kind === lexeme.kind && item.value === lexeme.value)) {
    existing.push(lexeme);
    phraseIndex.set(normalized, existing);
  }
}

for (const lexicon of numberLexicons) {
  for (const entry of lexicon.entries) for (const form of entry.forms) addPhrase(form, { kind: 'number', value: entry.value, fuzzy: false, form });
  for (const entry of lexicon.multipliers) for (const form of entry.forms) addPhrase(form, { kind: 'multiplier', value: entry.value, fuzzy: false, form });
  for (const entry of lexicon.fractions) for (const form of entry.forms) addPhrase(form, { kind: 'fraction', value: entry.value, fuzzy: false, form });
  for (const form of lexicon.currency) currencyForms.add(normalizePhrase(form));
}

const phraseTokens = [...phraseIndex.keys()].map((phrase) => phrase.split(' '));
const maxPhraseLength = Math.max(1, ...phraseTokens.map((tokens) => tokens.length));
const singleTokenLexemes = new Map<string, AmountLexeme[]>();
for (const [phrase, lexemes] of phraseIndex) {
  if (phrase.includes(' ')) continue;
  singleTokenLexemes.set(phrase, lexemes);
}

function tokenize(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const matcher = /₹|[\p{L}\p{M}\p{N}]+(?:[.,][\p{N}]+)*/gu;
  for (const match of text.matchAll(matcher)) {
    tokens.push({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, index: tokens.length });
  }
  return tokens;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let changes = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    changes += 1;
    if (changes > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return changes + Number(i < left.length || j < right.length) <= 1;
}

function lexemeAt(tokens: NumberToken[], position: number): LexiconMatch | { ambiguous: true; length: number } | null {
  const maxLength = Math.min(maxPhraseLength, tokens.length - position);
  for (let length = maxLength; length > 0; length -= 1) {
    const phrase = normalizePhrase(tokens.slice(position, position + length).map((token) => token.text).join(' '));
    const matches = phraseIndex.get(phrase);
    if (matches) {
      const multipliers = matches.filter((item) => item.kind === 'multiplier');
      const candidates = multipliers.length ? multipliers : matches;
      const outcomes = new Set(candidates.map((item) => `${item.kind}:${item.value}`));
      if (outcomes.size > 1) return { ambiguous: true, length };
      return { lexeme: candidates[0], length };
    }
  }
  const token = normalizePhrase(tokens[position].text);
  const numeric = tokens[position].text.replace(/[०-९౦-౯]/g, (digit) => digitMap[digit] ?? digit).replace(/,/g, '');
  if (/^\d+(?:\.\d{1,2})?$/.test(numeric)) {
    return { lexeme: { kind: 'number', value: Number(numeric), fuzzy: false, form: tokens[position].text }, length: 1 };
  }
  if (token.length < 4) return null;
  const possible: AmountLexeme[] = [];
  for (const [form, lexemes] of singleTokenLexemes) {
    if (form.length >= 4 && editDistanceAtMostOne(token, form)) possible.push(...lexemes);
  }
  const outcomes = new Set(possible.map((item) => `${item.kind}:${item.value}`));
  if (outcomes.size > 1) return { ambiguous: true, length: 1 };
  return possible.length ? { lexeme: { ...possible[0], fuzzy: true }, length: 1 } : null;
}

function parseGroup(lexemes: AmountLexeme[]): { value: number; confidence: number; matched: string[] } | null {
  if (!lexemes.length) return null;
  const fraction = lexemes.find((item) => item.kind === 'fraction');
  if (fraction) return { value: fraction.value, confidence: fraction.fuzzy ? 0.72 : 0.96, matched: [fraction.form] };
  let total = 0;
  let group = 0;
  let sawNumber = false;
  let hasFuzzy = false;
  const matched: string[] = [];
  for (const lexeme of lexemes) {
    hasFuzzy ||= lexeme.fuzzy;
    matched.push(lexeme.form);
    if (lexeme.kind === 'number') {
      group += lexeme.value;
      sawNumber = true;
    } else if (lexeme.value === 100) {
      group = Math.max(1, group) * 100;
      sawNumber = true;
    } else {
      total += Math.max(1, group) * lexeme.value;
      group = 0;
      sawNumber = true;
    }
  }
  const value = total + group;
  const singleDecimal = lexemes.length === 1 && lexemes[0].kind === 'number' && !Number.isInteger(lexemes[0].value);
  if (!sawNumber || (!Number.isSafeInteger(value) && !singleDecimal) || value <= 0 || value > MAX_AMOUNT_PAISE / 100) return null;
  return { value, confidence: hasFuzzy ? 0.72 : 0.96, matched };
}

const currencySet = new Set([...currencyForms, '₹', 'rs', 'rs.']);

function parseAmount(text: string, tokens: NumberToken[]): AmountResult {
  const groups: Array<{ start: number; end: number; hasCurrency: boolean; lexemes: AmountLexeme[]; ambiguous: boolean }> = [];
  let active: typeof groups[number] | null = null;
  for (let index = 0; index < tokens.length;) {
    const currencyToken = normalizePhrase(tokens[index].text);
    if (tokens[index].text === '₹' || currencySet.has(currencyToken)) {
      active ??= { start: index, end: index, hasCurrency: false, lexemes: [], ambiguous: false };
      active.hasCurrency = true;
      active.end = index;
      index += 1;
      continue;
    }
    const match = lexemeAt(tokens, index);
    if (match) {
      active ??= { start: index, end: index, hasCurrency: false, lexemes: [], ambiguous: false };
      if ('ambiguous' in match) active.ambiguous = true;
      else active.lexemes.push(match.lexeme);
      active.end = index + match.length - 1;
      index += match.length;
      continue;
    }
    if (active) groups.push(active);
    active = null;
    index += 1;
  }
  if (active) groups.push(active);
  const resolved = groups
    .map((group) => ({ group, value: group.ambiguous ? null : parseGroup(group.lexemes) }))
    .filter((item) => item.group.hasCurrency || item.value !== null || item.group.ambiguous);
  if (!resolved.length) return { paise: null, confidence: 0, heard: '', ambiguous: false, matched: [], customerQuery: extractCustomerQuery(tokens, null) };
  const monetary = resolved.filter((item) => item.group.hasCurrency);
  const candidates = monetary.length ? monetary : resolved;
  const valid = candidates.filter((item) => item.value !== null);
  if (valid.length > 1 || (candidates.length > 1 && valid.length !== 1)) {
    return { paise: null, confidence: 0.35, heard: candidates.map(({ group }) => text.slice(tokens[group.start].start, tokens[group.end].end)).join(' / '), ambiguous: true, matched: [], customerQuery: extractCustomerQuery(tokens, candidates[0]?.group.start ?? null) };
  }
  const selected = valid[0];
  if (!selected || selected.value === null) return { paise: null, confidence: 0.35, heard: '', ambiguous: true, matched: [], customerQuery: extractCustomerQuery(tokens, candidates[0]?.group.start ?? null) };
  const paise = rupeesToPaise(String(selected.value.value));
  if (paise === null) return { paise: null, confidence: 0, heard: '', ambiguous: false, matched: [], customerQuery: extractCustomerQuery(tokens, selected.group.start) };
  return {
    paise,
    confidence: selected.value.confidence,
    heard: text.slice(tokens[selected.group.start].start, tokens[selected.group.end].end),
    ambiguous: false,
    matched: selected.value.matched,
    customerQuery: extractCustomerQuery(tokens, selected.group.start),
  };
}

const nameStopWords = new Set([
  'ko', 'ne', 'ke', 'ki', 'se', 'nunchi', 'daggara', 'vadda', 'lo', 'ku', 'కు', 'को', 'ने', 'का', 'की', 'से', 'దగ్గర', 'నుంచి', 'వద్ద',
  ...cues.credit, ...cues.payment, ...cues.recipientMarkers, ...cues.payerMarkers, ...cues.gaveToVerbs, ...cues.payerVerbs,
]);

function extractCustomerQuery(tokens: NumberToken[], amountStart: number | null): string {
  const selected = amountStart === null ? tokens : tokens.slice(0, amountStart);
  const cleaned = selected
    .filter((token) => !nameStopWords.has(normalizePhrase(token.text)))
    .filter((token) => !/^\d/.test(token.text) && token.text !== '₹')
    .map((token) => token.text);
  return cleaned.join(' ').trim();
}

function cueWords(values: string[]): Set<string> {
  return new Set(values.flatMap((value) => [value, transliterate(value)]).map((value) => cueKey(value)).filter(Boolean));
}

function cueKey(value: string): string {
  return transliterate(value)
    .toLocaleLowerCase()
    .replace(/bh/g, 'b')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/sh/g, 's')
    .replace(/cch/g, 'ch')
    .replace(/v/g, 'w')
    .replace(/([aeiou])\1+/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const creditCueSet = cueWords(cues.credit);
const paymentCueSet = cueWords(cues.payment);
const recipientSet = cueWords(cues.recipientMarkers);
const payerSet = cueWords(cues.payerMarkers);
const gaveToSet = cueWords(cues.gaveToVerbs);
const payerVerbSet = cueWords(cues.payerVerbs);

function detectEventType(transcript: string): { type: 'credit_sale' | 'payment_received' | null; confidence: number; ambiguous: boolean } {
  const words = transliterate(transcript).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const keys = words.map(cueKey);
  const has = (set: Set<string>) => keys.some((word) => set.has(word));
  const recipient = has(recipientSet);
  const payer = has(payerSet);
  const giveVerb = has(gaveToSet);
  const payerVerb = has(payerVerbSet);
  const explicitCredit = has(creditCueSet);
  const explicitPayment = has(paymentCueSet);

  // A recipient marker before "gave" means the merchant gave goods on credit: "X ko ... diya".
  const creditDirection = recipient && giveVerb;
  // A payer marker before a payment verb means the customer paid the merchant: "X ne ... diye".
  const paymentDirection = payer && payerVerb;
  if (creditDirection && paymentDirection) return { type: null, confidence: 0.35, ambiguous: true };
  if (creditDirection) return { type: 'credit_sale', confidence: 0.96, ambiguous: false };
  if (paymentDirection) return { type: 'payment_received', confidence: 0.96, ambiguous: false };
  if (explicitCredit && explicitPayment) return { type: null, confidence: 0.35, ambiguous: true };
  if (explicitCredit) return { type: 'credit_sale', confidence: 0.9, ambiguous: false };
  if (explicitPayment) return { type: 'payment_received', confidence: 0.9, ambiguous: false };
  return { type: null, confidence: 0, ambiguous: false };
}

export type ParsedVoiceIntent = {
  customer_id: string;
  candidates: Customer[];
  customer_candidates: RankedCustomer[];
  customer_query: string;
  amount_paise: number | null;
  amount_confidence: number;
  amount_heard: string;
  amount_ambiguous: boolean;
  type: 'credit_sale' | 'payment_received' | null;
  type_confidence: number;
  type_ambiguous: boolean;
  clarification: string[];
  understood: Array<{ heard: string; understood: string; confidence: number }>;
  debug: { tokens: string[]; matched_lexicon_entries: string[]; customer_scores: Array<{ name: string; score: number }> };
  is_pending_query: boolean;
};

export function parseVoiceIntent(transcript: string, customers: Customer[]): ParsedVoiceIntent {
  const tokens = tokenize(transcript);
  const amount = parseAmount(transcript, tokens);
  const customerCandidates = matchCustomerCandidates(amount.customerQuery, customers);
  const customer_id = customerCandidates.length === 1 && customerCandidates[0].score >= 0.85
    ? customerCandidates[0].customer.id
    : '';
  const pendingWords = /pending|\bdue\b|\bbaaki\b|बाकी|మిగులు|బాకీ|owe/i.test(`${transcript} ${transliterate(transcript)}`);
  const eventType = pendingWords && !amount.paise
    ? { type: null, confidence: 0, ambiguous: false }
    : detectEventType(transcript);
  const clarification: string[] = [];
  if (!amount.paise) clarification.push(amount.ambiguous ? 'The amount is ambiguous; please enter it.' : 'Amount not detected; enter the amount.');
  if (!customer_id) clarification.push(customerCandidates.length ? 'Choose the intended customer.' : 'Choose or add a customer.');
  if (!eventType.type) clarification.push(eventType.ambiguous ? 'The event type is ambiguous; choose one.' : 'Choose payment received or credit sale.');
  const understood: ParsedVoiceIntent['understood'] = [];
  if (amount.heard && amount.paise !== null) {
    const rupees = amount.paise / 100;
    understood.push({
      heard: amount.heard,
      understood: `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
      confidence: amount.confidence,
    });
  }
  const matchedCustomer = customer_id ? customerCandidates.find((candidate) => candidate.customer.id === customer_id) : null;
  if (amount.customerQuery && matchedCustomer) {
    understood.push({ heard: amount.customerQuery, understood: matchedCustomer.customer.display_name, confidence: matchedCustomer.score });
  }
  return {
    customer_id,
    candidates: customerCandidates.map((candidate) => candidate.customer),
    customer_candidates: customerCandidates,
    customer_query: amount.customerQuery,
    amount_paise: amount.paise,
    amount_confidence: amount.confidence,
    amount_heard: amount.heard,
    amount_ambiguous: amount.ambiguous,
    type: eventType.type,
    type_confidence: eventType.confidence,
    type_ambiguous: eventType.ambiguous,
    clarification,
    understood,
    debug: {
      tokens: tokens.map((token) => token.text),
      matched_lexicon_entries: amount.matched,
      customer_scores: customerCandidates.map((candidate) => ({ name: candidate.customer.display_name, score: candidate.score })),
    },
    is_pending_query: pendingWords && !amount.paise,
  };
}
