import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { closeMerchantDatabase, createMerchantRepository, databaseName } from './repository';
import type { TransactionEvent } from '../domain/events';

const merchantIds: string[] = [];
function makeRepository() {
  const merchantId = `merchant-${crypto.randomUUID()}`;
  merchantIds.push(merchantId);
  return createMerchantRepository(merchantId);
}
function makeEvent(customerId: string): TransactionEvent {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), customer_id: customerId, type: 'credit_sale', amount_paise: 12500, note: 'Sale',
    occurred_at: now, client_timestamp: now, transcript_raw: '', speech_usage: 'manual', confirmed_by_user: true,
    created_at: now, sync_status: 'pending', is_demo: false,
  };
}
afterEach(async () => {
  await Promise.all(merchantIds.splice(0).map(async (merchantId) => {
    await closeMerchantDatabase(merchantId);
    await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase(databaseName(merchantId)); request.onsuccess = () => resolve(); request.onerror = () => resolve(); request.onblocked = () => resolve(); });
  }));
});

describe('merchant repository isolation', () => {
  it('migrates existing orders with a last-write-wins timestamp', async () => {
    const merchantId = `merchant-${crypto.randomUUID()}`;
    merchantIds.push(merchantId);
    const legacy = new Dexie(databaseName(merchantId));
    legacy.version(1).stores({
      customers: 'id, display_name, phone, created_at',
      transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
      orders: 'id, customer_id, status, created_at, is_demo',
      sync_queue: 'id, entity_type, entity_id, created_at, status',
      membership: 'merchant_id, plan_key',
      invoices: 'id, merchant_id, invoice_number, status, created_at',
      preferences: 'key',
    });

    await legacy.open();
    const created_at = Date.now();
    const customerId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    await legacy.table('customers').add({
      id: customerId, display_name: 'Legacy customer', phone: '', created_at, is_demo: false,
    });
    await legacy.table('orders').add({
      id: orderId, customer_id: customerId, description: 'Legacy order',
      status: 'New', created_at, is_demo: false,
    });
    legacy.close();

    const repository = createMerchantRepository(merchantId);
    expect(await repository.getCustomer(customerId)).toMatchObject({
      updated_at: created_at, updated_by_device: '', aliases: [],
    });
    expect(await repository.listOrders()).toContainEqual(expect.objectContaining({
      id: orderId, updated_at: created_at, updated_by_device: '',
    }));
  });

  it('renames legacy speech provider usage without dropping offline events', async () => {
    const merchantId = `merchant-${crypto.randomUUID()}`;
    merchantIds.push(merchantId);
    const legacy = new Dexie(databaseName(merchantId));
    legacy.version(1).stores({
      customers: 'id, display_name, phone, created_at',
      transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
      orders: 'id, customer_id, status, created_at, is_demo',
      sync_queue: 'id, entity_type, entity_id, created_at, status',
      membership: 'merchant_id, plan_key',
      invoices: 'id, merchant_id, invoice_number, status, created_at',
      preferences: 'key',
    });
    await legacy.open();
    const now = Date.now();
    const customerId = crypto.randomUUID();
    await legacy.table('customers').add({
      id: customerId, display_name: 'Speech user', phone: '', created_at: now, is_demo: false,
    });
    await legacy.table('transaction_events').add({
      id: crypto.randomUUID(), customer_id: customerId, type: 'credit_sale', amount_paise: 50000,
      note: '', occurred_at: now, client_timestamp: now, transcript_raw: '',
      speech_usage: 'vexyl_stt', confirmed_by_user: true, created_at: now,
      sync_status: 'pending', is_demo: false,
    });
    legacy.close();

    const repository = createMerchantRepository(merchantId);
    expect(await repository.listEvents()).toMatchObject([
      { speech_usage: 'local_stt', amount_paise: 50000 },
    ]);
  });

  it('seeds demo data once when initialization runs concurrently', async () => {
    const repository = makeRepository();
    await Promise.all([repository.seedDemoData(), repository.seedDemoData()]);
    expect(await repository.listCustomers()).toHaveLength(10);
    expect((await repository.listCustomers()).some((customer) => !customer.phone)).toBe(true);
    expect(await repository.listEvents()).toHaveLength(30);
    await repository.seedDemoData();
    expect(await repository.listCustomers()).toHaveLength(10);
  });

  it('creates and updates local customer aliases with a generated romanized name', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'కవిత రెడ్డి', phone: '', aliases: ['Kavitha'] });
    expect(customer.aliases).toContain('కవిత రెడ్డి');
    expect(customer.aliases).toContain('Kavitha');
    expect(customer.aliases).toContain('kavita reddi');
    const updated = await repository.updateCustomer(customer.id, {
      display_name: 'కవిత రెడ్డి',
      phone: '',
      aliases: ['Kavitha Reddy'],
      language: 'te',
    });
    expect(updated.aliases).toEqual(expect.arrayContaining(['కవిత రెడ్డి', 'Kavitha Reddy', 'kavita reddi']));
    expect(updated.language).toBe('te');
  });
  it('preserves demo customer records referenced by merchant-entered events during reset', async () => {
    const repository = makeRepository();
    await repository.seedDemoData();
    const referencedCustomer = (await repository.listCustomers())[0];
    const firstName = referencedCustomer.display_name.split(/\s+/)[0];
    const merchantEvent = { ...makeEvent(referencedCustomer.id), transcript_raw: `${firstName} nunchi 125 rupees vachayi` };
    await repository.createEvent(merchantEvent);
    await repository.clearDemoData();
    const preservedCustomer = await repository.getCustomer(referencedCustomer.id);
    expect(preservedCustomer?.is_demo).toBe(false);
    expect(preservedCustomer?.display_name).toBe(referencedCustomer.display_name);
    expect((await repository.eventsForCustomer(referencedCustomer.id)).filter((event) => !event.is_demo)).toHaveLength(1);
    await repository.seedDemoData();
    expect(await repository.listCustomers()).toHaveLength(10);
    expect((await repository.listCustomers()).filter((customer) => customer.is_demo)).toHaveLength(9);
    expect((await repository.eventsForCustomer(referencedCustomer.id)).filter((event) => !event.is_demo)).toHaveLength(1);
  });
  it('does not expose one merchant records to another merchant', async () => {
    const merchantA = makeRepository(); const merchantB = makeRepository();
    const customer = await merchantA.createCustomer({ display_name: 'Ravi', phone: '9876543210' });
    expect(await merchantA.getCustomer(customer.id)).toEqual(customer);
    expect(await merchantB.getCustomer(customer.id)).toBeUndefined();
    await expect(merchantB.createEvent(makeEvent(customer.id))).rejects.toThrow('outside this merchant ledger');
  });
  it('persists customer and event records after closing and reopening IndexedDB', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'Offline Customer', phone: '' });
    const event = makeEvent(customer.id);
    await repository.createEvent(event);
    const merchantId = repository.merchantId;
    await closeMerchantDatabase(merchantId);
    const reopened = createMerchantRepository(merchantId);
    expect(await reopened.getCustomer(customer.id)).toEqual(customer);
    expect(await reopened.getEvent(event.id)).toEqual(event);
    expect((await reopened.listSyncQueue()).filter((item) => item.status === 'pending')).toHaveLength(2);
  });
  it('limits customer detail events to the requested customer', async () => {
    const repository = makeRepository();
    const customerX = await repository.createCustomer({ display_name: 'Ravi', phone: '' });
    const customerY = await repository.createCustomer({ display_name: 'Sita', phone: '' });
    await repository.createEvent(makeEvent(customerX.id));
    await repository.createEvent(makeEvent(customerY.id));
    const events = await repository.eventsForCustomer(customerX.id);
    expect(events).toHaveLength(1);
    expect(events[0].customer_id).toBe(customerX.id);
    expect(await repository.eventsForCustomer(crypto.randomUUID())).toEqual([]);
  });
  it('creates a single same-customer same-amount reversal and rejects repeat or reversal-of-reversal', async () => {
    const repository = makeRepository();
    const customer = await repository.createCustomer({ display_name: 'Ravi', phone: '' });
    const original = makeEvent(customer.id);
    await repository.createEvent(original);
    const reversal = await repository.reverseEvent(customer.id, original.id, true);
    expect(reversal.amount_paise).toBe(original.amount_paise);
    expect(reversal.reverses_id).toBe(original.id);
    expect(reversal.is_demo).toBe(original.is_demo);
    await expect(repository.reverseEvent(customer.id, original.id, true)).rejects.toThrow('already been reversed');
    await expect(repository.reverseEvent(customer.id, reversal.id, true)).rejects.toThrow('cannot be reversed');
    await expect(repository.reverseEvent(customer.id, original.id, false)).rejects.toThrow('Confirm the reversal');
  });
});
