import Dexie, { type Table } from 'dexie';
import { customerSchema, eventSchema, orderInputSchema, type Customer, type Invoice, type MerchantMembership, type Order, type TransactionEvent, type SyncStatus } from '../domain/events';
import { buildCustomerAliases } from '../domain/customerMatching';

export type MerchantDatabase = Dexie & {
  customers: Table<Customer, string>;
  transaction_events: Table<TransactionEvent, string>;
  orders: Table<Order, string>;
  sync_queue: Table<SyncQueueItem, string>;
  membership: Table<MerchantMembership, string>;
  invoices: Table<Invoice, string>;
  preferences: Table<{ key: string; value: string }, string>;
};
export type SyncQueueItem = { id: string; entity_type: 'customer' | 'event' | 'order'; entity_id: string; created_at: number; status: 'pending' | 'rejected'; reason_code?: string };
const demoCustomerProfiles: Array<[string, string]> = [
  ['Ravi Kumar', '9876543210'], ['सीता देवी', '9876543211'], ['Ramesh Patel', ''],
  ['లక్ష్మి నారాయణ', '9876543213'], ['Ayesha Khan', '9876543214'], ['అర్జున్ రావు', ''],
  ['Meena Joshi', '9876543216'], ['फ़रहान अली', '9876543217'], ['కవిత రెడ్డి', '9876543218'], ['दीपक शाह', '9876543219'],
];

const databases = new Map<string, MerchantDatabase>();
function validateMerchantId(merchantId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(merchantId)) throw new Error('Invalid merchant scope.');
}
export function databaseName(merchantId: string): string {
  validateMerchantId(merchantId);
  return `lokmitra_${merchantId}`;
}
export function openMerchantDatabase(merchantId: string): MerchantDatabase {
  validateMerchantId(merchantId);
  const existing = databases.get(merchantId);
  if (existing) return existing;
  const database = new Dexie(databaseName(merchantId)) as MerchantDatabase;
  database.version(1).stores({
    customers: 'id, display_name, phone, created_at',
    transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
    orders: 'id, customer_id, status, created_at, is_demo',
    sync_queue: 'id, entity_type, entity_id, created_at, status',
    membership: 'merchant_id, plan_key',
    invoices: 'id, merchant_id, invoice_number, status, created_at',
    preferences: 'key',
  });
  database.version(2).stores({
    customers: 'id, display_name, phone, created_at, updated_at',
    transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
    orders: 'id, customer_id, status, created_at, updated_at, is_demo',
    sync_queue: 'id, entity_type, entity_id, created_at, status',
    membership: 'merchant_id, plan_key',
    invoices: 'id, merchant_id, invoice_number, status, created_at',
    preferences: 'key',
  }).upgrade(async (transaction) => {
    await transaction.table('customers').toCollection().modify((customer: Customer) => {
      customer.updated_at ??= customer.created_at;
      customer.updated_by_device ??= '';
    });
    await transaction.table('orders').toCollection().modify((order: Order) => {
      order.updated_at ??= order.created_at;
      order.updated_by_device ??= '';
    });
  });
  database.version(3).stores({
    customers: 'id, display_name, phone, created_at, updated_at',
    transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
    orders: 'id, customer_id, status, created_at, updated_at, is_demo',
    sync_queue: 'id, entity_type, entity_id, created_at, status',
    membership: 'merchant_id, plan_key',
    invoices: 'id, merchant_id, invoice_number, status, created_at',
    preferences: 'key',
  }).upgrade(async (transaction) => {
    await transaction.table('customers').toCollection().modify((customer: Customer) => {
      customer.aliases ??= [];
    });
  });
  database.version(4).stores({
    customers: 'id, display_name, phone, created_at, updated_at',
    transaction_events: 'id, customer_id, type, occurred_at, client_timestamp, sync_status, reverses_id',
    orders: 'id, customer_id, status, created_at, updated_at, is_demo',
    sync_queue: 'id, entity_type, entity_id, created_at, status',
    membership: 'merchant_id, plan_key',
    invoices: 'id, merchant_id, invoice_number, status, created_at',
    preferences: 'key',
  }).upgrade(async (transaction) => {
    await transaction.table('transaction_events').toCollection().modify((event: TransactionEvent) => {
      if ((event.speech_usage as string) === 'vexyl_stt') event.speech_usage = 'local_stt';
    });
  });
  databases.set(merchantId, database);
  return database;
}
export async function closeMerchantDatabase(merchantId: string): Promise<void> {
  const database = databases.get(merchantId);
  if (database) { database.close(); databases.delete(merchantId); }
}
export async function closeAllMerchantDatabases(): Promise<void> {
  await Promise.all([...databases.keys()].map(closeMerchantDatabase));
}

export type MerchantRepository = ReturnType<typeof createMerchantRepository>;
export function createMerchantRepository(merchantId: string) {
  const database = openMerchantDatabase(merchantId);
  return {
    merchantId,
    async listCustomers(): Promise<Customer[]> {
      return database.customers.toArray();
    },
    async getCustomer(customerId: string): Promise<Customer | undefined> {
      return database.customers.get(customerId);
    },
    async updateCustomer(customerId: string, input: { display_name: string; phone: string; aliases?: string[]; language?: 'en' | 'hi' | 'te' }): Promise<Customer> {
      const current = await database.customers.get(customerId);
      if (!current) throw new Error('Customer not found in this merchant ledger.');
      const valid = customerSchema.parse(input);
      const updated_at = Date.now();
      const updated = {
        ...current, ...valid, aliases: buildCustomerAliases(valid.display_name, valid.aliases), updated_at, updated_by_device: await this.getOrCreateDeviceId(), is_demo: false,
      };
      await database.transaction('rw', database.customers, database.sync_queue, async () => {
        await database.customers.put(updated);
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'customer', entity_id: customerId, created_at: updated_at, status: 'pending' });
      });
      return updated;
    },
    async getEvent(eventId: string): Promise<TransactionEvent | undefined> {
      return database.transaction_events.get(eventId);
    },
    async createCustomer(input: { display_name: string; phone: string; aliases?: string[]; language?: 'en' | 'hi' | 'te' }): Promise<Customer> {
      const valid = customerSchema.parse(input);
      const timestamp = Date.now();
      const customer: Customer = {
        id: crypto.randomUUID(), ...valid, aliases: buildCustomerAliases(valid.display_name, valid.aliases), created_at: timestamp, updated_at: timestamp,
        updated_by_device: await this.getOrCreateDeviceId(), is_demo: false,
      };
      await database.transaction('rw', database.customers, database.sync_queue, async () => {
        await database.customers.add(customer);
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'customer', entity_id: customer.id, created_at: customer.created_at, status: 'pending' });
      });
      return customer;
    },
    async listEvents(): Promise<TransactionEvent[]> {
      return database.transaction_events.orderBy('occurred_at').reverse().toArray();
    },
    async eventsForCustomer(customerId: string): Promise<TransactionEvent[]> {
      const customer = await database.customers.get(customerId);
      if (!customer) return [];
      return (await database.transaction_events.where('customer_id').equals(customerId).toArray()).sort((a, b) => b.occurred_at - a.occurred_at);
    },
    async createEvent(event: TransactionEvent): Promise<void> {
      eventSchema.parse(event);
      if (!event.confirmed_by_user) throw new Error('User confirmation is required before saving.');
      if (event.type === 'reversal') throw new Error('Use the guarded reversal workflow to create a reversal.');
      if (!await database.customers.get(event.customer_id)) throw new Error('Customer is outside this merchant ledger.');
      const localEvent = { ...event, sync_status: 'pending' as const };
      await database.transaction('rw', database.transaction_events, database.sync_queue, async () => {
        await database.transaction_events.add(localEvent);
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'event', entity_id: event.id, created_at: event.created_at, status: 'pending' });
      });
    },
    async reverseEvent(customerId: string, eventId: string, confirmedByUser: boolean): Promise<TransactionEvent> {
      if (!confirmedByUser) throw new Error('Confirm the reversal before saving.');
      const original = await database.transaction_events.get(eventId);
      if (!original || original.customer_id !== customerId) throw new Error('Event not found for this customer.');
      if (original.type === 'reversal') throw new Error('A reversal cannot be reversed.');
      const alreadyReversed = await database.transaction_events.where('reverses_id').equals(eventId).first();
      if (alreadyReversed) throw new Error('This event has already been reversed.');
      const timestamp = Date.now();
      const reversal: TransactionEvent = {
        id: crypto.randomUUID(), customer_id: customerId, type: 'reversal', amount_paise: original.amount_paise,
        note: `Reversal of ${original.id}`, occurred_at: timestamp, client_timestamp: timestamp, transcript_raw: '',
        speech_usage: 'manual', confirmed_by_user: true, reverses_id: original.id, created_at: timestamp,
        sync_status: 'pending', is_demo: false,
      };
      eventSchema.parse(reversal);
      await database.transaction('rw', database.transaction_events, database.sync_queue, async () => {
        const duplicate = await database.transaction_events.where('reverses_id').equals(eventId).first();
        if (duplicate) throw new Error('This event has already been reversed.');
        await database.transaction_events.add(reversal);
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'event', entity_id: reversal.id, created_at: timestamp, status: 'pending' });
      });
      return reversal;
    },
    async listOrders(): Promise<Order[]> {
      return database.orders.toArray();
    },
    async getMembership(): Promise<MerchantMembership | undefined> {
      return database.membership.get(merchantId);
    },
    async getPreference(key: string): Promise<string | undefined> {
      return (await database.preferences.get(key))?.value;
    },
    async getOrCreateDeviceId(): Promise<string> {
      return database.transaction('rw', database.preferences, async () => {
        const existing = await database.preferences.get('device-id');
        if (existing) return existing.value;
        const deviceId = crypto.randomUUID();
        await database.preferences.add({ key: 'device-id', value: deviceId });
        return deviceId;
      });
    },
    async setPreference(key: string, value: string): Promise<void> {
      await database.preferences.put({ key, value });
    },
    async saveMembership(membership: MerchantMembership): Promise<void> {
      if (membership.merchant_id !== merchantId) throw new Error('Membership is outside this merchant scope.');
      await database.membership.put(membership);
    },
    async listInvoices(): Promise<Invoice[]> {
      return (await database.invoices.where('merchant_id').equals(merchantId).toArray()).sort((a, b) => b.created_at - a.created_at);
    },
    async createInvoice(invoice: Invoice): Promise<void> {
      if (invoice.merchant_id !== merchantId) throw new Error('Invoice is outside this merchant scope.');
      await database.invoices.add(invoice);
    },
    async createOrder(customerId: string, description: string): Promise<Order> {
      if (!await database.customers.get(customerId)) throw new Error('Customer not found in this merchant ledger.');
      const valid = orderInputSchema.parse({ customer_id: customerId, description });
      const timestamp = Date.now();
      const order: Order = {
        id: crypto.randomUUID(), ...valid, status: 'New', created_at: timestamp, updated_at: timestamp,
        updated_by_device: await this.getOrCreateDeviceId(), is_demo: false,
      };
      await database.transaction('rw', database.orders, database.sync_queue, async () => {
        await database.orders.add(order);
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'order', entity_id: order.id, created_at: order.created_at, status: 'pending' });
      });
      return order;
    },
    async updateOrderStatus(orderId: string, status: Order['status']): Promise<void> {
      const current = await database.orders.get(orderId);
      if (!current) throw new Error('Order not found in this merchant ledger.');
      const updated_at = Date.now();
      const updated_by_device = await this.getOrCreateDeviceId();
      await database.transaction('rw', database.orders, database.sync_queue, async () => {
        await database.orders.update(orderId, { status, updated_at, updated_by_device, is_demo: false });
        await database.sync_queue.add({ id: crypto.randomUUID(), entity_type: 'order', entity_id: orderId, created_at: updated_at, status: 'pending' });
      });
    },
    async listSyncQueue(): Promise<SyncQueueItem[]> {
      return database.sync_queue.orderBy('created_at').toArray();
    },
    async updateQueueStatus(queueId: string, status: 'pending' | 'rejected', reason_code?: string): Promise<void> {
      await database.sync_queue.update(queueId, { status, reason_code });
    },
    async removeQueueItem(queueId: string): Promise<void> {
      await database.sync_queue.delete(queueId);
    },
    async removeQueueItems(queueIds: string[]): Promise<void> {
      await database.sync_queue.bulkDelete(queueIds);
    },
    async applyRemoteChanges(
      remoteCustomers: Array<{
        id: string; display_name: string; aliases: string[]; language?: 'en' | 'hi' | 'te' | null; phone_number: string | null; created_at: string;
        updated_at: number; updated_by_device: string;
      }>,
      remoteEvents: Array<{
        id: string; customer_id: string; type: TransactionEvent['type']; amount_paise: number;
        note: string | null; occurred_at: string; client_timestamp: number; transcript_raw: string | null;
        confirmed_by_user: boolean; reverses_id: string | null; speech_usage: TransactionEvent['speech_usage'];
        status?: TransactionEvent['status'];
      }>,
      remoteOrders: Array<{
        id: string; customer_id: string; description: string; status: Order['status'];
        created_at: number; updated_at: number; updated_by_device: string; is_demo: boolean;
      }>,
      nextCursor: string | null,
    ): Promise<void> {
      const customerRows = remoteCustomers.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        aliases: row.aliases ?? [],
        ...(row.language ? { language: row.language } : {}),
        phone: row.phone_number ?? '',
        created_at: Date.parse(row.created_at),
        updated_at: row.updated_at,
        updated_by_device: row.updated_by_device,
        is_demo: false,
      }));
      const eventRows: TransactionEvent[] = remoteEvents.map((row) => {
        if (!row.confirmed_by_user) throw new Error('Server returned an unconfirmed ledger event.');
        return {
          id: row.id,
          customer_id: row.customer_id,
          type: row.type,
          amount_paise: row.amount_paise,
          note: row.note ?? '',
          occurred_at: Date.parse(row.occurred_at),
          client_timestamp: row.client_timestamp,
          transcript_raw: row.transcript_raw ?? '',
          speech_usage: row.speech_usage,
          confirmed_by_user: true,
          ...(row.reverses_id ? { reverses_id: row.reverses_id } : {}),
          created_at: Date.parse(row.occurred_at),
          sync_status: 'synced',
          is_demo: false,
          status: row.status ?? 'CONFIRMED',
        };
      });
      for (const customer of customerRows) {
        if (!Number.isFinite(customer.created_at)) throw new Error('Server returned an invalid customer timestamp.');
      }
      for (const event of eventRows) eventSchema.parse(event);
      await database.transaction('rw', database.customers, database.transaction_events, database.orders, database.preferences, async () => {
        const customerIds = new Set(customerRows.map((customer) => customer.id));
        const localCustomers = new Set(await database.customers.toCollection().primaryKeys());
        const localCustomerIds = new Set([...localCustomers, ...customerIds]);
        if (eventRows.some((event) => !localCustomerIds.has(event.customer_id))) {
          throw new Error('Server returned a ledger event without its customer profile.');
        }
        for (const customer of customerRows) {
          if (!Number.isSafeInteger(customer.updated_at)) throw new Error('Server returned an invalid customer timestamp.');
          const current = await database.customers.get(customer.id);
          const currentUpdatedAt = current?.updated_at ?? current?.created_at ?? -1;
          const currentDevice = current?.updated_by_device ?? '';
          const incomingIsNewer = customer.updated_at > currentUpdatedAt ||
            (customer.updated_at === currentUpdatedAt && customer.updated_by_device > currentDevice);
          if (!current || incomingIsNewer) await database.customers.put(customer);
        }
        for (const event of eventRows) {
          const current = await database.transaction_events.get(event.id);
          if (current && (current.customer_id !== event.customer_id || current.type !== event.type || current.amount_paise !== event.amount_paise)) {
            throw new Error('Server returned an event ID that conflicts with the local ledger.');
          }
          if (!current) await database.transaction_events.add(event);
          else if (event.status === 'VOIDED' && current.status !== 'VOIDED') {
            await database.transaction_events.update(event.id, { status: 'VOIDED', sync_status: 'synced' });
          }
        }
        for (const order of remoteOrders) {
          if (!localCustomerIds.has(order.customer_id)) throw new Error('Server returned an order without its customer profile.');
          if (!Number.isSafeInteger(order.created_at) || !Number.isSafeInteger(order.updated_at)) throw new Error('Server returned an invalid order timestamp.');
          const current = await database.orders.get(order.id);
          const currentUpdatedAt = current?.updated_at ?? current?.created_at ?? -1;
          const currentDevice = current?.updated_by_device ?? '';
          const incomingIsNewer = order.updated_at > currentUpdatedAt ||
            (order.updated_at === currentUpdatedAt && order.updated_by_device > currentDevice);
          if (!current || incomingIsNewer) await database.orders.put(order);
        }
        await database.preferences.put({ key: 'sync-cursor', value: nextCursor ?? '' });
      });
    },
    async rejectEvent(eventId: string, reason: string): Promise<void> {
      await database.transaction('rw', database.transaction_events, database.sync_queue, async () => {
        await database.transaction_events.update(eventId, { sync_status: 'rejected', rejected_reason: reason });
        const queue = (await database.sync_queue.where('entity_id').equals(eventId).toArray()).find((item) => item.entity_type === 'event');
        if (queue) await database.sync_queue.update(queue.id, { status: 'rejected', reason_code: reason });
      });
    },
    async markEventSynced(eventId: string): Promise<void> {
      await database.transaction('rw', database.transaction_events, database.sync_queue, async () => {
        await database.transaction_events.update(eventId, { sync_status: 'synced', rejected_reason: undefined });
        const queueRows = await database.sync_queue.where('entity_id').equals(eventId).toArray();
        await database.sync_queue.bulkDelete(queueRows.filter((item) => item.entity_type === 'event').map((item) => item.id));
      });
    },
    async markEventVoided(eventId: string): Promise<void> {
      await database.transaction_events.update(eventId, { status: 'VOIDED', sync_status: 'synced' });
    },
    async deleteEventRejection(eventId: string): Promise<void> {
      await database.transaction('rw', database.transaction_events, database.sync_queue, async () => {
        await database.transaction_events.update(eventId, { sync_status: 'pending', rejected_reason: undefined });
        const queueRows = await database.sync_queue.where('entity_id').equals(eventId).toArray();
        await database.sync_queue.bulkUpdate(queueRows.filter((item) => item.entity_type === 'event').map((item) => ({ key: item.id, changes: { status: 'pending' as const, reason_code: undefined } })));
      });
    },
    async updateEventSyncStatus(eventId: string, syncStatus: SyncStatus, reason?: string): Promise<void> {
      await database.transaction_events.update(eventId, { sync_status: syncStatus, rejected_reason: reason });
    },
    async seedDemoData(): Promise<void> {
      const timestamp = Date.now();
      await database.transaction('rw', database.customers, database.transaction_events, database.orders, async () => {
        const existingCustomers = await database.customers.toArray();
        const byPhone = new Map(existingCustomers.filter((customer) => customer.phone).map((customer) => [customer.phone, customer]));
        const byName = new Map(existingCustomers.map((customer) => [customer.display_name, customer]));
        const customers: Customer[] = demoCustomerProfiles.map(([display_name, phone]) => byName.get(display_name) ?? (phone ? byPhone.get(phone) : undefined) ?? ({
          id: crypto.randomUUID(), display_name, phone, aliases: buildCustomerAliases(display_name), created_at: timestamp, updated_at: timestamp,
          updated_by_device: '', is_demo: true,
        }));
        const newCustomers = customers.filter((customer) => !existingCustomers.some((existing) => existing.id === customer.id));
        if (newCustomers.length) await database.customers.bulkAdd(newCustomers);
        const [existingEvents, existingOrders] = await Promise.all([database.transaction_events.toArray(), database.orders.toArray()]);
        if (!existingEvents.some((event) => event.is_demo)) {
          const events: TransactionEvent[] = Array.from({ length: 30 }, (_, index) => {
            const customer = customers[index % customers.length];
            const type = index % 4 === 1 ? 'payment_received' : index % 11 === 0 ? 'payable' : index % 13 === 0 ? 'refund' : 'credit_sale';
            return {
              id: crypto.randomUUID(), customer_id: customer.id, type, amount_paise: (index + 2) * 12500,
              note: ['Tailoring work', 'Fresh lunch order', 'Home repair', 'Handloom item'][index % 4],
              occurred_at: timestamp - (index % 8) * 86_400_000, client_timestamp: timestamp - (index % 8) * 86_400_000,
              transcript_raw: '', speech_usage: 'manual', confirmed_by_user: true, created_at: timestamp,
              sync_status: 'synced', is_demo: true,
            };
          });
          await database.transaction_events.bulkAdd(events);
        }
        if (!existingOrders.some((order) => order.is_demo)) {
          const orderRows: Order[] = customers.slice(0, 6).map((customer, index) => ({
            id: crypto.randomUUID(), customer_id: customer.id,
            description: ['Blouse alterations', 'Festival snack boxes', 'Fan repair', 'Handloom dupatta', 'Mehendi booking', 'Birthday cake'][index],
            status: (['In Progress', 'Ready', 'New', 'Completed', 'Completed', 'In Progress'] as Order['status'][])[index],
            created_at: timestamp - (index % 4) * 86_400_000, updated_at: timestamp, is_demo: true,
          }));
          await database.orders.bulkAdd(orderRows);
        }
      });
    },
    async clearDemoData(): Promise<void> {
      await database.transaction('rw', database.customers, database.transaction_events, database.orders, database.sync_queue, async () => {
        const [orders, events, customers, queue] = await Promise.all([database.orders.toArray(), database.transaction_events.toArray(), database.customers.toArray(), database.sync_queue.toArray()]);
        const preservedCustomerIds = new Set([
          ...events.filter((item) => !item.is_demo).map((item) => item.customer_id),
          ...orders.filter((item) => !item.is_demo).map((item) => item.customer_id),
        ]);
        const preservedEventIds = new Set(events.filter((item) => !item.is_demo && item.reverses_id).map((item) => item.reverses_id!));
        const demoOrderIds = new Set(orders.filter((item) => item.is_demo).map((item) => item.id));
        const demoEventIds = new Set(events.filter((item) => item.is_demo && !preservedEventIds.has(item.id)).map((item) => item.id));
        const demoCustomerIds = new Set(customers.filter((item) => item.is_demo && !preservedCustomerIds.has(item.id)).map((item) => item.id));
        const knownCustomerIds = new Set(customers.map((item) => item.id));
        const recoveredCustomers: Customer[] = [...preservedCustomerIds].filter((customerId) => !knownCustomerIds.has(customerId)).map((customerId) => {
          const transcript = events.find((event) => event.customer_id === customerId && event.transcript_raw)?.transcript_raw.toLocaleLowerCase() ?? '';
          const recoveredProfile = demoCustomerProfiles.find(([displayName]) => transcript.includes(displayName.split(/\s+/)[0].toLocaleLowerCase()));
          const timestamp = Date.now();
          return {
            id: customerId, display_name: recoveredProfile?.[0] ?? 'Recovered customer',
            phone: recoveredProfile?.[1] ?? '', aliases: buildCustomerAliases(recoveredProfile?.[0] ?? 'Recovered customer'), created_at: timestamp, updated_at: timestamp,
            updated_by_device: '', is_demo: false,
          };
        });
        for (const customerId of preservedCustomerIds) {
          const knownCustomer = customers.find((customer) => customer.id === customerId);
          if (knownCustomer) {
            const transcript = events.find((event) => event.customer_id === customerId && event.transcript_raw)?.transcript_raw.toLocaleLowerCase() ?? '';
            const recoveredProfile = demoCustomerProfiles.find(([displayName]) => transcript.includes(displayName.split(/\s+/)[0].toLocaleLowerCase()));
            await database.customers.update(customerId, {
              is_demo: false,
              ...(knownCustomer.display_name === 'Recovered customer' && recoveredProfile ? { display_name: recoveredProfile[0], phone: recoveredProfile[1] } : {}),
            });
          }
        }
        for (const eventId of preservedEventIds) await database.transaction_events.update(eventId, { is_demo: false });
        if (recoveredCustomers.length) await database.customers.bulkAdd(recoveredCustomers);
        await database.orders.bulkDelete([...demoOrderIds]);
        await database.transaction_events.bulkDelete([...demoEventIds]);
        await database.customers.bulkDelete([...demoCustomerIds]);
        await database.sync_queue.bulkDelete(queue.filter((item) => demoOrderIds.has(item.entity_id) || demoEventIds.has(item.entity_id) || demoCustomerIds.has(item.entity_id)).map((item) => item.id));
      });
      await database.transaction('rw', database.invoices, database.membership, async () => {
        await database.invoices.clear();
        await database.membership.put({ merchant_id: merchantId, plan_key: 'free', speech_minutes_used: 0, period_start: new Date().toISOString().slice(0, 10) });
      });
    },
  };
}
