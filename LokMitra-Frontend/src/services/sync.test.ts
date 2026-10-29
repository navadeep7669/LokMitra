import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMerchantDatabase, createMerchantRepository, databaseName } from '../data/repository';
import type { SupabaseSyncGateway } from './sync';
import { createSupabaseSyncService } from './sync';

const merchantIds: string[] = [];
function makeRepository() {
  const merchantId = `sync-${crypto.randomUUID()}`;
  merchantIds.push(merchantId);
  return createMerchantRepository(merchantId);
}
function makeGateway(overrides: Partial<SupabaseSyncGateway> = {}) {
  const gateway: SupabaseSyncGateway = {
    currentUserId: vi.fn(async () => crypto.randomUUID()),
    pushCustomers: vi.fn(async () => undefined),
    pushEvents: vi.fn(async () => undefined),
    pushOrders: vi.fn(async () => undefined),
    voidConfirmedEvent: vi.fn(async () => undefined),
    pullChanges: vi.fn(async () => ({ customers: [], events: [], orders: [] })),
    ...overrides,
  };
  return gateway;
}

afterEach(async () => {
  await Promise.all(merchantIds.splice(0).map(async (merchantId) => {
    await closeMerchantDatabase(merchantId);
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(databaseName(merchantId));
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }));
});

describe('Supabase outbox sync', () => {
  it('keeps offline writes queued and pushes them after reconnecting', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'Offline customer', phone: '' });
    const gateway = makeGateway();
    const service = createSupabaseSyncService(() => gateway);

    const offline = await service.sync(repository, false);
    expect(offline).toMatchObject({ synced: 0, pending: 1 });
    expect(gateway.currentUserId).not.toHaveBeenCalled();
    expect((await repository.listSyncQueue())[0].status).toBe('pending');

    const online = await service.sync(repository, true);
    expect(online).toMatchObject({ synced: 1, pending: 0 });
    expect(gateway.pushCustomers).toHaveBeenCalledWith([
      expect.objectContaining({ id: customer.id, display_name: 'Offline customer' }),
    ]);
  });

  it('leaves the outbox intact when a push fails', async () => {
    const repository = makeRepository();
    await repository.createCustomer({ display_name: 'Pending customer', phone: '' });
    const gateway = makeGateway({
      pushCustomers: vi.fn(async () => { throw new Error('Supabase unavailable.'); }),
    });

    await expect(createSupabaseSyncService(() => gateway).sync(repository, true))
      .rejects.toThrow(/Supabase unavailable/);
    expect((await repository.listSyncQueue()).filter((item) => item.status === 'pending')).toHaveLength(1);
  });

  it('retries the same upsert safely when the server pull fails after push', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'Idempotent customer', phone: '' });
    const pullChanges = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary pull failure.'))
      .mockResolvedValueOnce({ customers: [], events: [], orders: [] });
    const gateway = makeGateway({ pullChanges });
    const service = createSupabaseSyncService(() => gateway);

    await expect(service.sync(repository, true)).rejects.toThrow(/pull failure/);
    expect((await repository.listSyncQueue()).filter((item) => item.status === 'pending')).toHaveLength(1);
    await service.sync(repository, true);

    expect(gateway.pushCustomers).toHaveBeenCalledTimes(2);
    expect(gateway.pushCustomers).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ id: customer.id }),
    ]);
    expect(gateway.pushCustomers).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ id: customer.id }),
    ]);
    expect((await repository.listSyncQueue()).filter((item) => item.status === 'pending')).toHaveLength(0);
  });

  it('voids a confirmed remote row by status update instead of inserting a reversal row', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'Ledger customer', phone: '' });
    const timestamp = Date.now();
    const eventId = crypto.randomUUID();
    await repository.createEvent({
      id: eventId,
      customer_id: customer.id,
      type: 'credit_sale',
      amount_paise: 2500,
      note: 'Sale',
      occurred_at: timestamp,
      client_timestamp: timestamp,
      transcript_raw: '',
      speech_usage: 'manual',
      confirmed_by_user: true,
      created_at: timestamp,
      sync_status: 'pending',
      is_demo: false,
    });
    const gateway = makeGateway();
    const service = createSupabaseSyncService(() => gateway);
    await service.sync(repository, true);

    const reversal = await repository.reverseEvent(customer.id, eventId, true);
    await service.sync(repository, true);
    expect(gateway.voidConfirmedEvent).toHaveBeenCalledWith(eventId, expect.any(String));
    expect(gateway.pushEvents).toHaveBeenCalledTimes(1);
    expect(gateway.pushEvents).toHaveBeenCalledWith([
      expect.objectContaining({ id: eventId, type: 'credit_sale', status: 'CONFIRMED' }),
    ]);
    expect((await repository.getEvent(reversal.id))?.sync_status).toBe('synced');
    expect((await repository.getEvent(eventId))?.status).toBe('VOIDED');
  });
});
