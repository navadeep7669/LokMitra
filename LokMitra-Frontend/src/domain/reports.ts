import { effectiveEvents, type TransactionEvent } from './events';

export type DailyReport = {
  events: TransactionEvent[];
  creditPaise: number;
  paymentPaise: number;
  eventCount: number;
};

export function aggregateDailyReport(events: TransactionEvent[], date: string): DailyReport {
  const dayEvents = effectiveEvents(events).filter(
    (event) => new Date(event.occurred_at).toISOString().slice(0, 10) === date,
  );
  return {
    events: dayEvents,
    creditPaise: dayEvents.filter((event) => event.type === 'credit_sale').reduce((total, event) => total + event.amount_paise, 0),
    paymentPaise: dayEvents.filter((event) => event.type === 'payment_received').reduce((total, event) => total + event.amount_paise, 0),
    eventCount: dayEvents.length,
  };
}
