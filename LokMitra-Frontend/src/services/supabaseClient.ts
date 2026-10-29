import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { EventType, SpeechUsage } from '../domain/events';

export type CustomerRow = {
  id: string;
  merchant_id: string;
  display_name: string;
  aliases: string[];
  language: 'en' | 'hi' | 'te' | null;
  phone_number: string | null;
  created_at: string;
  updated_at: number;
  updated_by_device: string;
  server_ts: string;
};
export type EventRow = {
  id: string;
  merchant_id: string;
  customer_id: string;
  type: EventType;
  amount_paise: number;
  note: string | null;
  occurred_at: string;
  client_timestamp: number;
  transcript_raw: string | null;
  speech_usage: SpeechUsage;
  confirmed_by_user: boolean;
  reverses_id: string | null;
  status: 'CONFIRMED' | 'VOIDED';
  server_ts: string;
};
export type OrderRow = {
  id: string;
  merchant_id: string;
  customer_id: string;
  description: string;
  status: 'New' | 'In Progress' | 'Ready' | 'Completed';
  created_at: number;
  is_demo: boolean;
  updated_at: number;
  updated_by_device: string;
  server_ts: string;
};

export type Database = {
  public: {
    Tables: {
      customers: {
        Row: CustomerRow;
        Insert: Omit<CustomerRow, 'server_ts'>;
        Update: Partial<Omit<CustomerRow, 'id' | 'merchant_id' | 'server_ts'>>;
        Relationships: [];
      };
      transaction_events: {
        Row: EventRow;
        Insert: Omit<EventRow, 'server_ts'>;
        Update: Pick<EventRow, 'status'>;
        Relationships: [];
      };
      orders: {
        Row: OrderRow;
        Insert: Omit<OrderRow, 'server_ts'>;
        Update: Partial<Omit<OrderRow, 'id' | 'merchant_id' | 'server_ts'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabaseClient: SupabaseClient<Database> | null =
  supabaseUrl && supabaseAnonKey
    ? createClient<Database>(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true,
        },
      })
    : null;

function configuredClient(): SupabaseClient<Database> {
  if (!supabaseClient) {
    throw new Error('Supabase is not configured. Set the frontend Supabase URL and anonymous key.');
  }
  return supabaseClient;
}

export async function getSupabaseSession() {
  const { data, error } = await configuredClient().auth.getSession();
  if (error) throw new Error(`Could not restore the Supabase session: ${error.message}`);
  return data.session;
}

export async function signInAnonymously() {
  const { data, error } = await configuredClient().auth.signInAnonymously({
    options: { data: { display_name: 'My business' } },
  });
  if (error) throw new Error(`Could not sign in: ${error.message}`);
  if (!data.session || !data.user) throw new Error('Supabase did not return an authenticated session.');
  return data.session;
}

export async function signOutSupabase() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw new Error(`Could not sign out: ${error.message}`);
}

export function subscribeToSupabaseAuth(
  callback: (session: Awaited<ReturnType<typeof getSupabaseSession>>) => void,
): () => void {
  if (!supabaseClient) return () => undefined;
  const { data } = supabaseClient.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}
