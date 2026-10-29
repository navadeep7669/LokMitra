import { describe, expect, it } from 'vitest';
import {
  balanceOwedPaise, effectiveEvents, escapeCsvField, parseVoiceIntent,
  type Customer, type TransactionEvent,
} from './events';
import { gstInPaise, paiseToRupees, rupeesToPaise } from './money';

const customer: Customer = {
  id: 'c1', display_name: 'Ravi Kumar', phone: '9876543210', aliases: [], created_at: 1, updated_at: 1, is_demo: true,
};
const event = (id: string, type: TransactionEvent['type'], amount_paise: number, extra: Partial<TransactionEvent> = {}): TransactionEvent => ({
  id, customer_id: 'c1', type, amount_paise, note: '', occurred_at: 1, client_timestamp: 1, transcript_raw: '',
  speech_usage: 'manual', confirmed_by_user: true, created_at: 1, sync_status: 'synced', is_demo: true, ...extra,
});

describe('money and event balance', () => {
  it('parses and formats integer paise at the UI boundary', () => {
    expect(rupeesToPaise('₹1,234.50')).toBe(123450);
    expect(rupeesToPaise('0')).toBeNull();
    expect(paiseToRupees(123450)).toContain('1,234.50');
  });
  it('counts sales less payments and ignores refunds, payables, and reversed events', () => {
    const events = [event('sale', 'credit_sale', 10000), event('pay', 'payment_received', 2500), event('refund', 'refund', 900), event('payable', 'payable', 800), event('rev', 'reversal', 10000, { reverses_id: 'sale' })];
    expect(balanceOwedPaise(events, 'c1')).toBe(-2500);
  });
  it('keeps the original in balance when its reversal was rejected', () => {
    const events = [event('sale', 'credit_sale', 10000), event('rev', 'reversal', 10000, { reverses_id: 'sale', sync_status: 'rejected' })];
    expect(balanceOwedPaise(events, 'c1')).toBe(10000);
  });
  it('excludes rejected events and includes locally pending confirmed events', () => {
    const events = [
      event('local', 'credit_sale', 10000, { sync_status: 'pending' }),
      event('rejected', 'credit_sale', 5000, { sync_status: 'rejected' }),
    ];
    expect(balanceOwedPaise(events, 'c1')).toBe(10000);
  });
  it('excludes validly reversed originals from event-based reports', () => {
    const events = [event('sale', 'credit_sale', 10000), event('rev', 'reversal', 10000, { reverses_id: 'sale' })];
    expect(effectiveEvents(events).map((item) => item.id)).toEqual([]);
  });
  it('formats GST using integer paise arithmetic', () => {
    expect(gstInPaise(10001)).toBe(1800);
  });
  it('neutralizes CSV formula prefixes and quotes fields', () => {
    expect(escapeCsvField('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
    expect(escapeCsvField('Ravi "shop"')).toBe('"Ravi ""shop"""');
  });
});

describe('voice intent parsing', () => {
  it.each([
    ['Ravi nunchi 500 rupees vachayi', 'payment_received', 50000],
    ['Ravi ko पाँच सौ रुपये उधार दिया', 'credit_sale', 50000],
    ['Ravi ki ఐదు వంద రూపాయలు ichanu', 'credit_sale', 50000],
    ['Ravi received ₹500', 'payment_received', 50000],
  ] as const)('parses %s', (transcript, type, amount) => {
    const result = parseVoiceIntent(transcript, [customer]);
    expect(result.customer_id).toBe('c1');
    expect(result.type).toBe(type);
    expect(result.amount_paise).toBe(amount);
  });
  it('does not guess between equally matching customer candidates', () => {
    const result = parseVoiceIntent('Ravi 500 rupees', [customer, { ...customer, id: 'c2', display_name: 'Ravi Rao' }]);
    expect(result.customer_id).toBe('');
    expect(result.candidates).toHaveLength(2);
    expect(result.clarification).toContain('Choose the intended customer.');
  });
  it('recognizes pending balance requests without inventing a transaction', () => {
    const result = parseVoiceIntent('show Ravi pending baaki', [customer]);
    expect(result.is_pending_query).toBe(true);
    expect(result.type).toBeNull();
    expect(result.amount_paise).toBeNull();
  });
  it.each([
    ['Ravi received ₹500', 'payment_received'], ['Ravi paid 500 rupees', 'payment_received'],
    ['Ravi payment 500 received', 'payment_received'], ['Ravi paid ₹250', 'payment_received'],
    ['Ravi received 125 rupees', 'payment_received'], ['Ravi payment received 75', 'payment_received'],
    ['Ravi nunchi 500 vachayi', 'payment_received'], ['Ravi se 300 payment mila', 'payment_received'],
    ['Ravi 500 रुपये जमा', 'payment_received'], ['Ravi se 200 रुपये मिला', 'payment_received'],
    ['Ravi received 50', 'payment_received'], ['Ravi paid 100 rupees today', 'payment_received'],
    ['Ravi gave ₹500 credit', 'credit_sale'], ['Ravi sold 500 rupees', 'credit_sale'],
    ['Ravi credit 450', 'credit_sale'], ['Ravi gave 200 rupees on credit', 'credit_sale'],
    ['Ravi ki 500 రూపాయలు ఇచ్చాను', 'credit_sale'], ['Ravi 300 rupees ichanu', 'credit_sale'],
    ['Ravi ki 250 credit ichanu', 'credit_sale'], ['Ravi 100 రూపాయలు ఇచ్చాను', 'credit_sale'],
    ['Ravi ko 500 रुपये उधार दिया', 'credit_sale'], ['Ravi ko 300 उधार', 'credit_sale'],
    ['Ravi 250 रुपया उधार', 'credit_sale'], ['Ravi उधार 100 रुपये दिया', 'credit_sale'],
    ['Ravi payment received ₹50', 'payment_received'], ['Ravi paid ₹75', 'payment_received'],
    ['Ravi nunchi 125 rupees vachayi', 'payment_received'], ['Ravi vachindi 100 rupees nunchi', 'payment_received'],
    ['Ravi sold 75', 'credit_sale'], ['Ravi credit 125 rupees', 'credit_sale'],
    ['Ravi ko 75 रुपये उधार', 'credit_sale'], ['Ravi se 75 payment vachayi', 'payment_received'],
  ] as const)('handles supported code-mixed phrase: %s', (transcript, type) => {
    expect(parseVoiceIntent(transcript, [customer]).type).toBe(type);
  });
});
