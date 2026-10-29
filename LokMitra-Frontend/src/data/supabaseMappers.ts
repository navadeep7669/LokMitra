import type { Customer, Order, TransactionEvent } from '../domain/events';
import type { Database } from '../services/supabaseClient';

export type SupabaseCustomer = Database['public']['Tables']['customers']['Row'];
export type SupabaseEvent = Database['public']['Tables']['transaction_events']['Row'];
export type SupabaseOrder = Database['public']['Tables']['orders']['Row'];

export function customerToSupabase(customer: Customer, merchantId: string): Database['public']['Tables']['customers']['Insert'] {
  return {
    id: customer.id,
    merchant_id: merchantId,
    display_name: customer.display_name,
    aliases: customer.aliases ?? [],
    language: customer.language ?? null,
    phone_number: customer.phone || null,
    created_at: new Date(customer.created_at).toISOString(),
    updated_at: customer.updated_at ?? customer.created_at,
    updated_by_device: customer.updated_by_device ?? '00000000-0000-0000-0000-000000000000',
  };
}

export function customerFromSupabase(row: SupabaseCustomer): Customer {
  return {
    id: row.id,
    display_name: row.display_name,
    aliases: row.aliases ?? [],
    ...(row.language ? { language: row.language } : {}),
    phone: row.phone_number ?? '',
    created_at: Date.parse(row.created_at),
    updated_at: row.updated_at,
    updated_by_device: row.updated_by_device,
    is_demo: false,
  };
}

export function eventToSupabase(event: TransactionEvent, merchantId: string): Database['public']['Tables']['transaction_events']['Insert'] {
  return {
    id: event.id,
    merchant_id: merchantId,
    customer_id: event.customer_id,
    type: event.type,
    amount_paise: event.amount_paise,
    note: event.note || null,
    occurred_at: new Date(event.occurred_at).toISOString(),
    client_timestamp: event.client_timestamp,
    transcript_raw: event.transcript_raw || null,
    speech_usage: event.speech_usage,
    confirmed_by_user: event.confirmed_by_user,
    reverses_id: event.reverses_id ?? null,
    status: event.status ?? 'CONFIRMED',
  };
}

export function eventFromSupabase(row: SupabaseEvent): TransactionEvent {
  const occurredAt = Date.parse(row.occurred_at);
  if (!Number.isFinite(occurredAt)) throw new Error('Supabase returned an invalid event timestamp.');
  if (!row.confirmed_by_user) throw new Error('Supabase returned an unconfirmed ledger event.');
  return {
    id: row.id,
    customer_id: row.customer_id,
    type: row.type as TransactionEvent['type'],
    amount_paise: row.amount_paise,
    note: row.note ?? '',
    occurred_at: occurredAt,
    client_timestamp: row.client_timestamp,
    transcript_raw: row.transcript_raw ?? '',
    speech_usage: row.speech_usage as TransactionEvent['speech_usage'],
    confirmed_by_user: true,
    ...(row.reverses_id ? { reverses_id: row.reverses_id } : {}),
    created_at: occurredAt,
    sync_status: 'synced',
    is_demo: false,
    status: row.status,
  };
}

export function orderToSupabase(order: Order, merchantId: string): Database['public']['Tables']['orders']['Insert'] {
  return {
    id: order.id,
    merchant_id: merchantId,
    customer_id: order.customer_id,
    description: order.description,
    status: order.status,
    created_at: order.created_at,
    is_demo: order.is_demo,
    updated_at: order.updated_at ?? order.created_at,
    updated_by_device: order.updated_by_device ?? '00000000-0000-0000-0000-000000000000',
  };
}

export function orderFromSupabase(row: SupabaseOrder): Order {
  return {
    id: row.id,
    customer_id: row.customer_id,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    is_demo: false,
    updated_at: row.updated_at,
    updated_by_device: row.updated_by_device,
  };
}
