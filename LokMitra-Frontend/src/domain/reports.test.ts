import { describe, expect, it } from 'vitest';
import { balanceOwedPaise, type TransactionEvent } from './events';
import { aggregateDailyReport } from './reports';

const makeEvent = (id: string, type: TransactionEvent['type'], amount_paise: number, extra: Partial<TransactionEvent> = {}): TransactionEvent => ({
  id, customer_id: 'customer', type, amount_paise, note: '', occurred_at: Date.UTC(2026, 0, 1),
  client_timestamp: 1, transcript_raw: '', speech_usage: 'manual', confirmed_by_user: true,
  created_at: 1, sync_status: 'synced', is_demo: false, ...extra,
});

describe('daily report aggregation', () => {
  it('uses the same effective ledger events and balance formula', () => {
    const events = [
      makeEvent('sale', 'credit_sale', 10000),
      makeEvent('payment', 'payment_received', 2500),
      makeEvent('refund', 'refund', 900),
      makeEvent('reversed', 'reversal', 10000, { reverses_id: 'sale' }),
    ];
    const report = aggregateDailyReport(events, '2026-01-01');
    expect(report.creditPaise - report.paymentPaise).toBe(balanceOwedPaise(events));
    expect(report.eventCount).toBe(2);
  });
});
