import type { MerchantRepository, SyncQueueItem } from '../data/repository';
import {
  customerToSupabase,
  eventToSupabase,
  orderToSupabase,
} from '../data/supabaseMappers';
import type { TransactionEvent } from '../domain/events';
import {
  supabaseClient,
  type CustomerRow,
  type EventRow,
  type OrderRow,
} from './supabaseClient';

export type SyncResult = { synced: number; rejected: number; pending: number };
export interface SyncService {
  sync(repository: MerchantRepository, online: boolean): Promise<SyncResult>;
}

export const mockSyncService: SyncService = {
  async sync(repository, online) {
    const queue = await repository.listSyncQueue();
    if (!online) return { synced: 0, rejected: 0, pending: queue.filter((item) => item.status === 'pending').length };
    const events = new Map<string, TransactionEvent>();
    await Promise.all(queue.filter((item) => item.entity_type === 'event').map(async (item) => {
      const event = await repository.getEvent(item.entity_id);
      if (event) events.set(item.entity_id, event);
    }));
    const sorted = queue.sort((a, b) => a.created_at - b.created_at);
    let synced = 0;
    let rejected = 0;
    for (const item of sorted) {
      if (item.status === 'rejected') {
        rejected += 1;
        continue;
      }
      if (item.entity_type === 'event') {
        const event = events.get(item.entity_id);
        if (!event) {
          await repository.updateQueueStatus(item.id, 'rejected', 'EVENT_MISSING');
          rejected += 1;
          continue;
        }
        if (!event.confirmed_by_user) {
          await repository.rejectEvent(event.id, 'USER_CONFIRMATION_REQUIRED');
          rejected += 1;
          continue;
        }
        await repository.markEventSynced(event.id);
      } else {
        await repository.removeQueueItem(item.id);
      }
      synced += 1;
    }
    return { synced, rejected, pending: (await repository.listSyncQueue()).filter((item) => item.status === 'pending').length };
  },
};

export type SupabasePulledRows = {
  customers: CustomerRow[];
  events: EventRow[];
  orders: OrderRow[];
};

export type SupabaseSyncGateway = {
  currentUserId(): Promise<string>;
  pushCustomers(rows: ReturnType<typeof customerToSupabase>[]): Promise<void>;
  pushEvents(rows: ReturnType<typeof eventToSupabase>[]): Promise<void>;
  pushOrders(rows: ReturnType<typeof orderToSupabase>[]): Promise<void>;
  voidConfirmedEvent(eventId: string, merchantId: string): Promise<void>;
  pullChanges(merchantId: string, cursor: string | null): Promise<SupabasePulledRows>;
};

function createSupabaseGateway(): SupabaseSyncGateway {
  if (!supabaseClient) {
    throw new Error('Supabase is not configured. Set the frontend Supabase URL and anonymous key.');
  }
  const client = supabaseClient;

  return {
    async currentUserId() {
      const { data, error } = await client.auth.getSession();
      if (error) throw new Error(`Could not restore the Supabase session: ${error.message}`);
      if (!data.session?.user.id) throw new Error('Sign in before syncing to Supabase.');
      return data.session.user.id;
    },
    async pushCustomers(rows) {
      if (rows.length === 0) return;
      const { error } = await client.from('customers').upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`Customer sync failed: ${error.message}`);
    },
    async pushEvents(rows) {
      if (rows.length === 0) return;
      const { error } = await client.from('transaction_events').upsert(rows, {
        onConflict: 'id',
        ignoreDuplicates: true,
      });
      if (error) throw new Error(`Transaction sync failed: ${error.message}`);
    },
    async pushOrders(rows) {
      if (rows.length === 0) return;
      const { error } = await client.from('orders').upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`Order sync failed: ${error.message}`);
    },
    async voidConfirmedEvent(eventId, merchantId) {
      const { data, error } = await client
        .from('transaction_events')
        .update({ status: 'VOIDED' })
        .eq('id', eventId)
        .eq('merchant_id', merchantId)
        .eq('status', 'CONFIRMED')
        .select('id');
      if (error) throw new Error(`Could not void the confirmed transaction: ${error.message}`);
      if (data.length > 0) return;
      const { data: current, error: readError } = await client
        .from('transaction_events')
        .select('id, status')
        .eq('id', eventId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      if (readError) throw new Error(`Could not verify the transaction status: ${readError.message}`);
      if (current?.status !== 'VOIDED') throw new Error('The confirmed transaction to void was not found.');
    },
    async pullChanges(merchantId, cursor) {
      const pageSize = 500;
      const customers: CustomerRow[] = [];
      const events: EventRow[] = [];
      const orders: OrderRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        if (offset >= pageSize * 100) throw new Error('Supabase pull exceeded the safe page limit.');
        let query = client.from('customers').select('*').eq('merchant_id', merchantId).order('server_ts').order('id').range(offset, offset + pageSize - 1);
        if (cursor) query = query.gte('server_ts', cursor);
        const { data, error } = await query;
        if (error) throw new Error(`Could not pull customers: ${error.message}`);
        customers.push(...data);
        if (data.length < pageSize) break;
      }
      for (let offset = 0; ; offset += pageSize) {
        if (offset >= pageSize * 100) throw new Error('Supabase pull exceeded the safe page limit.');
        let query = client.from('transaction_events').select('*').eq('merchant_id', merchantId).order('server_ts').order('id').range(offset, offset + pageSize - 1);
        if (cursor) query = query.gte('server_ts', cursor);
        const { data, error } = await query;
        if (error) throw new Error(`Could not pull transactions: ${error.message}`);
        events.push(...data);
        if (data.length < pageSize) break;
      }
      for (let offset = 0; ; offset += pageSize) {
        if (offset >= pageSize * 100) throw new Error('Supabase pull exceeded the safe page limit.');
        let query = client.from('orders').select('*').eq('merchant_id', merchantId).order('server_ts').order('id').range(offset, offset + pageSize - 1);
        if (cursor) query = query.gte('server_ts', cursor);
        const { data, error } = await query;
        if (error) throw new Error(`Could not pull orders: ${error.message}`);
        orders.push(...data);
        if (data.length < pageSize) break;
      }
      return { customers, events, orders };
    },
  };
}

function mapRequiredRows<T extends { id: string }, M extends { id: string }>(
  queueItems: SyncQueueItem[],
  records: T[],
  map: (record: T) => M,
  kind: string,
): M[] {
  const ids = [...new Set(queueItems.map((item) => item.entity_id))];
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`A pending ${kind} is missing from the local database; its outbox item was retained.`);
    return map(record);
  });
}

export function createSupabaseSyncService(
  gatewayFactory: () => SupabaseSyncGateway = createSupabaseGateway,
): SyncService {
  return {
    async sync(repository, online) {
      const queue = await repository.listSyncQueue();
      const pendingQueue = queue.filter((item) => item.status === 'pending');
      if (!online) return { synced: 0, rejected: 0, pending: pendingQueue.length };
      if (pendingQueue.length === 0) {
        const gateway = gatewayFactory();
        const merchantId = await gateway.currentUserId();
        const cursor = await repository.getPreference('sync-cursor') ?? null;
        const pulled = await gateway.pullChanges(merchantId, cursor);
        const nextCursor = [...pulled.customers, ...pulled.events, ...pulled.orders]
          .reduce<string | null>((latest, row) => !latest || row.server_ts > latest ? row.server_ts : latest, cursor);
        await repository.applyRemoteChanges(pulled.customers, pulled.events, pulled.orders, nextCursor);
        return { synced: 0, rejected: 0, pending: 0 };
      }

      const gateway = gatewayFactory();
      const merchantId = await gateway.currentUserId();
      const queuedCustomers = pendingQueue.filter((item) => item.entity_type === 'customer');
      const queuedEvents = pendingQueue.filter((item) => item.entity_type === 'event');
      const queuedOrders = pendingQueue.filter((item) => item.entity_type === 'order');
      const [allCustomers, allEvents, allOrders] = await Promise.all([
        repository.listCustomers(),
        Promise.all([...new Set(queuedEvents.map((item) => item.entity_id))].map((id) => repository.getEvent(id))),
        repository.listOrders(),
      ]);
      const eventRows = allEvents.filter((row): row is TransactionEvent => row !== undefined);
      const customers = mapRequiredRows(queuedCustomers, allCustomers, (row) => row, 'customer');
      const events = mapRequiredRows(queuedEvents, eventRows, (row) => row, 'transaction');
      const orders = mapRequiredRows(queuedOrders, allOrders, (row) => row, 'order');

      const customerRows = customers.filter((row) => !row.is_demo).map((row) => customerToSupabase(row, merchantId));
      const regularEvents = events.filter((row) => row.type !== 'reversal' && !row.is_demo);
      const reversalEvents = events.filter((row) => row.type === 'reversal' && !row.is_demo);
      const eventInsertRows = regularEvents.map((row) => eventToSupabase(row, merchantId));
      const orderRows = orders.filter((row) => !row.is_demo).map((row) => orderToSupabase(row, merchantId));

      if (customerRows.length > 0) await gateway.pushCustomers(customerRows);
      if (eventInsertRows.length > 0) await gateway.pushEvents(eventInsertRows);
      if (orderRows.length > 0) await gateway.pushOrders(orderRows);
      for (const reversal of reversalEvents) {
        if (!reversal.reverses_id) throw new Error('A local reversal is missing its confirmed transaction reference.');
        await gateway.voidConfirmedEvent(reversal.reverses_id, merchantId);
      }

      const savedCursor = await repository.getPreference('sync-cursor') ?? null;
      const pulled = await gateway.pullChanges(merchantId, savedCursor);
      const nextCursor = [...pulled.customers, ...pulled.events, ...pulled.orders]
        .reduce<string | null>((latest, row) => !latest || row.server_ts > latest ? row.server_ts : latest, savedCursor);
      await repository.applyRemoteChanges(pulled.customers, pulled.events, pulled.orders, nextCursor);

      for (const item of queuedCustomers) await repository.removeQueueItem(item.id);
      for (const item of queuedOrders) await repository.removeQueueItem(item.id);
      for (const event of events) await repository.markEventSynced(event.id);
      for (const reversal of reversalEvents) {
        if (reversal.reverses_id) await repository.markEventVoided(reversal.reverses_id);
      }
      return {
        synced: pendingQueue.length,
        rejected: 0,
        pending: (await repository.listSyncQueue()).filter((item) => item.status === 'pending').length,
      };
    },
  };
}

export const supabaseSyncService = createSupabaseSyncService();
