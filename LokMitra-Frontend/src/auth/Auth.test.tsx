import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, LoginPage, RequireRole } from './Auth';
import { authService, demoCredentials } from '../services/auth';

afterEach(async () => { cleanup(); await authService.logout(); });
function GuardHarness({ path }: { path: string }) {
  return <MemoryRouter initialEntries={[path]}><AuthProvider><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<RequireRole role="merchant" />}><Route path="/app/dashboard" element={<p>Merchant workspace</p>} /></Route>
    <Route element={<RequireRole role="developer" />}><Route path="/dev/overview" element={<p>Developer workspace</p>} /></Route>
  </Routes></AuthProvider></MemoryRouter>;
}

describe('local demo auth and route guards', () => {
  it('redirects an unauthenticated merchant route to login', async () => {
    render(<GuardHarness path="/app/dashboard" />);
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
  it('surfaces errors while restoring the saved session', async () => {
    vi.spyOn(authService, 'getSession').mockRejectedValue(new Error('Session service unavailable.'));
    render(<GuardHarness path="/login" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Session service unavailable.');
    vi.restoreAllMocks();
  });
  it('redirects a wrong-role visit to that role own portal', async () => {
    await authService.login('developer', demoCredentials.developer.email, demoCredentials.developer.password);
    render(<GuardHarness path="/app/dashboard" />);
    expect(await screen.findByText('Developer workspace')).toBeInTheDocument();
  });
  it('allows the selected demo role to sign in and routes to its portal', async () => {
    const user = userEvent.setup(); render(<GuardHarness path="/login" />);
    await user.click(screen.getByRole('button', { name: 'Developer' }));
    await user.type(screen.getByLabelText('Email'), demoCredentials.developer.email);
    await user.type(screen.getByLabelText('Password'), demoCredentials.developer.password);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Developer workspace')).toBeInTheDocument();
    expect(sessionStorage.getItem('lokmitra-local-session')).toContain('developer');
  });
});
