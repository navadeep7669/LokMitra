import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireRole } from '../auth/Auth';
import { authService, demoCredentials } from '../services/auth';
import { createMerchantRepository } from '../data/repository';
import { MerchantPortal } from './MerchantPortal';

const merchantId = 'demo-merchant';
async function mount(path: string) {
  await authService.login('merchant', demoCredentials.merchant.email, demoCredentials.merchant.password);
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><Routes><Route element={<RequireRole role="merchant" />}><Route path="/app/*" element={<MerchantPortal />} /></Route></Routes></AuthProvider></MemoryRouter>);
}
async function removeTestDatabase() {
  await cleanup(); await authService.logout();
  await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase(`lokmitra_${merchantId}`); request.onsuccess = () => resolve(); request.onerror = () => resolve(); request.onblocked = () => resolve(); });
}

afterEach(removeTestDatabase);

describe('merchant confirmation and reset workflows', () => {
  it('guards malformed and missing customer IDs with a not-found state', async () => {
    await mount('/app/customers/not-a-customer-id');
    expect(await screen.findByText('This customer link is invalid.')).toBeInTheDocument();
    cleanup();
    await mount('/app/customers/00000000-0000-4000-8000-000000000001');
    expect(await screen.findByText('This customer is not in the current merchant ledger.')).toBeInTheDocument();
  });

  it('does not save a voice event until explicit confirmation and resists double submit', async () => {
    const user = userEvent.setup(); const repository = createMerchantRepository(merchantId);
    await repository.seedDemoData(); await mount('/app/voice');
    await waitFor(async () => expect(await repository.listEvents()).toHaveLength(30));
    await user.click(screen.getByRole('button', { name: /ravi nunchi 500/i }));
    await user.click(await screen.findByRole('option', { name: /Ravi Kumar/ }));
    await user.click(screen.getByRole('button', { name: /review and confirm/i }));
    expect(await repository.listEvents()).toHaveLength(30);
    const confirmButton = screen.getByRole('button', { name: /confirm and save/i });
    fireEvent.click(confirmButton); fireEvent.click(confirmButton);
    await waitFor(async () => expect(await repository.listEvents()).toHaveLength(31));
    expect((await repository.listEvents()).filter((event) => event.speech_usage === 'manual' && event.amount_paise === 50000 && !event.is_demo)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await repository.listEvents()).toHaveLength(32));
    expect((await repository.listEvents()).filter((event) => event.type === 'reversal' && !event.is_demo)).toHaveLength(1);
  });

  it('lets an unknown spoken name be added without saving the draft financial event', async () => {
    const user = userEvent.setup();
    const repository = createMerchantRepository(merchantId);
    await repository.seedDemoData();
    await mount('/app/voice');
    await waitFor(async () => expect(await repository.listEvents()).toHaveLength(30));
    fireEvent.change(screen.getByLabelText('Original transcript'), { target: { value: 'Navdeep ₹500.' } });
    expect(screen.getByText(/No customer found for/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add as new customer/i }));
    await user.click(screen.getByRole('button', { name: /Add customer/i }));
    await waitFor(async () => expect(await repository.listCustomers()).toHaveLength(11));
    expect(await repository.listEvents()).toHaveLength(30);
    expect(screen.getByLabelText('Customer')).toHaveValue('Navdeep');
    await user.click(screen.getByRole('button', { name: /Credit sale/i }));
    await user.click(screen.getByRole('button', { name: /Review and confirm/i }));
    expect(await repository.listEvents()).toHaveLength(30);
    await user.click(screen.getByRole('button', { name: /Confirm and save/i }));
    await waitFor(async () => expect(await repository.listEvents()).toHaveLength(31));
  });

  it('defaults speech recognition to the app language and persists manual language choices', async () => {
    const repository = createMerchantRepository(merchantId);
    await repository.setPreference('language', 'te');
    await mount('/app/voice');
    await waitFor(() => expect(screen.getByRole('button', { name: /తెలుగు te-IN/i })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: /हिन्दी hi-IN/i }));
    await waitFor(async () => expect(await repository.getPreference('speech-input-language')).toBe('hi'));
  });
  it('requires explicit reset confirmation and preserves merchant-entered customers', async () => {
    const user = userEvent.setup(); const repository = createMerchantRepository(merchantId);
    await repository.seedDemoData();
    const merchantCustomer = await repository.createCustomer({ display_name: 'My Customer', phone: '' });
    await mount('/app/settings');
    await user.click(await screen.findByRole('button', { name: /reset demo data/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await repository.listCustomers()).toHaveLength(11);
    await user.click(screen.getByRole('button', { name: /confirm reset/i }));
    await waitFor(async () => expect((await repository.listCustomers()).filter((customer) => customer.is_demo)).toHaveLength(10));
    expect(await repository.getCustomer(merchantCustomer.id)).toEqual(merchantCustomer);
  });
});
