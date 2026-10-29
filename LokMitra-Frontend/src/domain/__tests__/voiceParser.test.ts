import { describe, expect, it } from 'vitest';
import fixtures from './voice.fixtures.json';
import { parseVoiceIntent } from '../events';
import type { Customer } from '../events';

const customer = (id: string, display_name: string, aliases: string[] = []): Customer => ({
  id,
  display_name,
  phone: '',
  aliases,
  created_at: 1,
  updated_at: 1,
  is_demo: false,
});

describe('multilingual voice fixture accuracy', () => {
  it.each(fixtures)('parses amount for "$transcript"', ({ transcript, amount_paise }) => {
    expect(parseVoiceIntent(transcript, []).amount_paise).toBe(amount_paise);
  });

  it('meets the minimum fixture amount accuracy', () => {
    const successes = fixtures.filter(({ transcript, amount_paise }) => (
      parseVoiceIntent(transcript, []).amount_paise === amount_paise
    )).length;
    expect(successes / fixtures.length).toBeGreaterThanOrEqual(0.95);
  });

  it.each(fixtures.filter((fixture) => fixture.type))('detects direction for "$transcript"', ({ transcript, type }) => {
    expect(parseVoiceIntent(transcript, []).type).toBe(type);
  });
});

describe('event direction and customer matching', () => {
  const knownCustomers = [
    customer('sita', 'सीता देवी'),
    customer('ramesh', 'रमेश पटेल'),
    customer('ravi-te', 'రవి కుమార్'),
    customer('kavitha', 'కవిత రెడ్డి'),
    customer('lakshmi', 'లక్ష్మి నారాయణ'),
    customer('deepak', 'दीपक शाह'),
    customer('ayesha', 'Ayesha Khan'),
  ];

  it.each([
    ['सीता को पाँच सौ रुपये उधार दिया', 'sita', 50000, 'credit_sale'],
    ['Sita ko paanch sau rupaye udhar diya', 'sita', 50000, 'credit_sale'],
    ['रमेश ने ढाई सौ दिए', 'ramesh', 25000, 'payment_received'],
    ['रवि దగ్గర ఐదు వందలు బాకీ రాసుకో', 'ravi-te', 50000, 'credit_sale'],
    ['కవిత రెండు వందల యాభై ఇచ్చింది', 'kavitha', 25000, 'payment_received'],
    ['Ravi nunchi 500 rupees vachayi', 'ravi-te', 50000, 'payment_received'],
  ] as const)('parses %s with direction-specific intent', (transcript, customerId, paise, type) => {
    const result = parseVoiceIntent(transcript, knownCustomers);
    expect(result.customer_id).toBe(customerId);
    expect(result.amount_paise).toBe(paise);
    expect(result.type).toBe(type);
    expect(Number.isInteger(result.amount_paise)).toBe(true);
  });

  it.each([
    ['Deepak', 'deepak'],
    ['Kavitha', 'kavitha'],
    ['Lakshmi', 'lakshmi'],
    ['Ayesha', 'ayesha'],
  ])('cross-script matches %s', (query, expectedId) => {
    const result = parseVoiceIntent(`${query} ₹500`, knownCustomers);
    expect(result.customer_id).toBe(expectedId);
  });

  it('keeps an unknown typed name available to add without losing a valid amount', () => {
    const result = parseVoiceIntent('Navdeep ₹500.', knownCustomers);
    expect(result.customer_id).toBe('');
    expect(result.customer_query).toBe('Navdeep');
    expect(result.amount_paise).toBe(50000);
  });

  it('does not auto-select two close-name matches', () => {
    const result = parseVoiceIntent('Ravi ₹500', [
      customer('ravi-one', 'Ravi Kumar'),
      customer('ravi-two', 'Ravi Rao'),
    ]);
    expect(result.customer_id).toBe('');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['ravi-one', 'ravi-two']);
  });

  it('leaves conflicting event cues unselected', () => {
    const result = parseVoiceIntent('Ravi 500 credit payment received', knownCustomers);
    expect(result.type).toBeNull();
    expect(result.type_ambiguous).toBe(true);
  });

  it('returns an integer paise amount and actionable missing-amount clarification', () => {
    const result = parseVoiceIntent('Navdeep received the money', knownCustomers);
    expect(result.amount_paise).toBeNull();
    expect(result.clarification).toContain('Amount not detected; enter the amount.');
  });
});
