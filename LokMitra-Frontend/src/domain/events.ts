import { z } from 'zod';
import { MAX_AMOUNT_PAISE } from './money';
export { gstInPaise, paiseToRupees, rupeesToPaise } from './money';
export { parseVoiceIntent } from './voiceParser';
export type { ParsedVoiceIntent } from './voiceParser';

export const EVENT_TYPES = ['credit_sale', 'payment_received', 'refund', 'payable', 'reversal'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type SyncStatus = 'pending' | 'synced' | 'rejected';
export type SpeechUsage = 'manual' | 'browser_speech' | 'local_stt' | 'sarvam_saaras_v3' | 'bhashini' | 'sherpa_onnx';
export type LanguageCode = 'en' | 'hi' | 'te' | 'hinglish';
export type LedgerEventStatus = 'CONFIRMED' | 'VOIDED';

export type Customer = {
  id: string;
  display_name: string;
  phone: string;
  aliases: string[];
  language?: 'en' | 'hi' | 'te';
  created_at: number;
  updated_at: number;
  updated_by_device?: string;
  is_demo: boolean;
};
export type AppSettings = {
  language: 'en' | 'hi' | 'te';
  speech_output_enabled: boolean;
  speech_input_language: LanguageCode;
  cloud_assist_consent: boolean;
  last_sync_at: number | null;
  last_sync_error: string | null;
};
export type TransactionEvent = {
  id: string;
  customer_id: string;
  type: EventType;
  amount_paise: number;
  note: string;
  occurred_at: number;
  client_timestamp: number;
  transcript_raw: string;
  speech_usage: SpeechUsage;
  confirmed_by_user: true;
  reverses_id?: string;
  status?: LedgerEventStatus;
  created_at: number;
  sync_status: SyncStatus;
  rejected_reason?: string;
  is_demo: boolean;
};
export type Order = {
  id: string;
  customer_id: string;
  description: string;
  status: 'New' | 'In Progress' | 'Ready' | 'Completed';
  created_at: number;
  updated_at: number;
  updated_by_device?: string;
  is_demo: boolean;
};
export type PlanKey = 'free' | 'pro' | 'business';
export type Plan = {
  key: PlanKey;
  name: string;
  monthly_paise: number;
  yearly_paise: number;
  speech_minutes: number;
  customer_limit: number;
  features: string[];
};
export type Invoice = {
  id: string;
  merchant_id: string;
  invoice_number: string;
  plan_key: PlanKey;
  subtotal_paise: number;
  gst_paise: number;
  total_paise: number;
  status: 'paid' | 'pending' | 'failed';
  created_at: number;
};
export type Subscription = {
  merchant_id: string;
  merchant_name: string;
  plan_key: PlanKey;
  status: 'active' | 'past_due' | 'cancelled';
  renewal_date: string;
  monthly_paise: number;
};
export type MerchantMembership = {
  merchant_id: string;
  plan_key: PlanKey;
  speech_minutes_used: number;
  period_start: string;
};

export const eventSchema = z.object({
  id: z.string().uuid(),
  customer_id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  amount_paise: z.number().int().positive().max(MAX_AMOUNT_PAISE),
  note: z.string().max(500),
  occurred_at: z.number().int().nonnegative(),
  client_timestamp: z.number().int().nonnegative(),
  transcript_raw: z.string().max(2000),
  speech_usage: z.enum(['manual', 'browser_speech', 'local_stt', 'sarvam_saaras_v3', 'bhashini', 'sherpa_onnx']),
  confirmed_by_user: z.literal(true),
  reverses_id: z.string().uuid().optional(),
  status: z.enum(['CONFIRMED', 'VOIDED']).optional(),
  created_at: z.number().int().nonnegative(),
  sync_status: z.enum(['pending', 'synced', 'rejected']),
  rejected_reason: z.string().optional(),
  is_demo: z.boolean(),
}).superRefine((event, context) => {
  if ((event.type === 'reversal') !== Boolean(event.reverses_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reverses_id'], message: 'A reversal must reference exactly one event.' });
  }
});
export const customerSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(24).regex(/^[+\d\s()-]*$/),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  language: z.enum(['en', 'hi', 'te']).optional(),
});
export const orderInputSchema = z.object({
  customer_id: z.string().uuid(),
  description: z.string().trim().min(1).max(240),
});

export function effectiveEvents(events: TransactionEvent[]): TransactionEvent[] {
  const activeReversals = new Set(
    events
      .filter((event) => event.type === 'reversal' && event.sync_status !== 'rejected')
      .map((event) => event.reverses_id),
  );
  return events.filter((event) =>
    event.type !== 'reversal' &&
    event.status !== 'VOIDED' &&
    event.sync_status !== 'rejected' &&
    !activeReversals.has(event.id),
  );
}

export function balanceOwedPaise(events: TransactionEvent[], customerId?: string): number {
  return effectiveEvents(events).reduce((balance, event) => {
    if (customerId && event.customer_id !== customerId) return balance;
    if (event.type === 'credit_sale') return balance + event.amount_paise;
    if (event.type === 'payment_received') return balance - event.amount_paise;
    return balance;
  }, 0);
}

export function escapeCsvField(value: string): string {
  const neutralized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${neutralized.replace(/"/g, '""')}"`;
}
export function eventsToCsv(events: TransactionEvent[], customers: Customer[]): string {
  const names = new Map(customers.map((customer) => [customer.id, customer.display_name]));
  const header = ['id', 'customer', 'type', 'amount_paise', 'note', 'occurred_at', 'sync_status'];
  const rows = events.map((event) => [event.id, names.get(event.customer_id) ?? '', event.type, String(event.amount_paise), event.note, new Date(event.occurred_at).toISOString(), event.sync_status]);
  return [header, ...rows].map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
}
