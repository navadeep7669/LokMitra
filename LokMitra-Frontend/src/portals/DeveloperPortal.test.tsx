import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireRole } from '../auth/Auth';
import { authService, demoCredentials } from '../services/auth';
import { DeveloperPortal } from './DeveloperPortal';

afterEach(async () => {
  cleanup();
  await authService.logout();
});

async function mount(path: string) {
  await authService.login('developer', demoCredentials.developer.email, demoCredentials.developer.password);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route element={<RequireRole role="developer" />}>
            <Route path="/dev/*" element={<DeveloperPortal />} />
          </Route>
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('developer portal navigation', () => {
  it('defaults to overview and only shows the remaining working navigation items', async () => {
    await mount('/dev');
    const navigation = await screen.findByRole('navigation', { name: 'Developer navigation' });
    expect(await screen.findByRole('heading', { name: 'Developer overview' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/dev/overview');
    expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveClass('active');
    expect(within(navigation).getByRole('link', { name: 'Subscriptions' })).toHaveAttribute('href', '/dev/subscriptions');
    expect(within(navigation).getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/dev/invoices');
    expect(within(navigation).getByRole('link', { name: 'Sync inspector' })).toHaveAttribute('href', '/dev/sync-inspector');
    expect(within(navigation).queryByText(/API keys|API docs/i)).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole('link')).toHaveLength(4);
  });

  it.each(['/dev/api-keys', '/dev/docs'])('does not expose the removed route %s', async (path) => {
    await mount(path);
    expect(await screen.findByText('This developer page does not exist.')).toBeInTheDocument();
  });
});
