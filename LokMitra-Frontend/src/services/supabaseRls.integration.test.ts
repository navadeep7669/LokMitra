import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const runIntegrationTest = import.meta.env.VITE_RUN_SUPABASE_RLS_TESTS === '1';

describe.skipIf(!url || !anonKey || !runIntegrationTest)('Supabase two-user RLS integration', () => {
  it('prevents a second anonymous user from reading or updating the first user’s row', async () => {
    const userA = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const userB = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const [{ data: sessionA, error: errorA }, { data: sessionB, error: errorB }] = await Promise.all([
      userA.auth.signInAnonymously(),
      userB.auth.signInAnonymously(),
    ]);
    expect(errorA).toBeNull();
    expect(errorB).toBeNull();
    if (!sessionA.user || !sessionB.user) throw new Error('Supabase did not return anonymous users.');

    const rowId = crypto.randomUUID();
    const { error: insertError } = await userA.from('customers').insert({
      id: rowId,
      merchant_id: sessionA.user.id,
      display_name: 'RLS test customer',
      phone_number: null,
    });
    expect(insertError).toBeNull();

    const { data: rowsVisibleToB, error: readError } = await userB
      .from('customers')
      .select('id')
      .eq('id', rowId);
    expect(readError).toBeNull();
    expect(rowsVisibleToB).toEqual([]);

    const { data: rowsUpdatedByB, error: updateError } = await userB
      .from('customers')
      .update({ display_name: 'Unauthorized update' })
      .eq('id', rowId)
      .select('id');
    expect(updateError).toBeNull();
    expect(rowsUpdatedByB).toEqual([]);

    const { data: ownerRow, error: ownerReadError } = await userA
      .from('customers')
      .select('display_name')
      .eq('id', rowId)
      .single();
    expect(ownerReadError).toBeNull();
    expect(ownerRow?.display_name).toBe('RLS test customer');
  });
});
