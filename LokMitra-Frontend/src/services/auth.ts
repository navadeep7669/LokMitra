import { z } from 'zod';
import { closeAllMerchantDatabases } from '../data/repository';
import {
  getSupabaseSession,
  isSupabaseConfigured,
  signInAnonymously,
  signOutSupabase,
  subscribeToSupabaseAuth,
} from './supabaseClient';

export const authSessionSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['merchant', 'developer']),
  display_name: z.string().min(1),
  access_token: z.string().min(1).optional(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;
export type UserRole = AuthSession['role'];
export interface AuthService {
  login(role: UserRole, email: string, password: string): Promise<AuthSession>;
  logout(): Promise<void>;
  getSession(): Promise<AuthSession | null>;
  subscribe(callback: (session: AuthSession | null) => void): () => void;
}

const SESSION_KEY = 'lokmitra-local-session';
const demoUsers = {
  merchant: { email: 'merchant@demo.lokmitra', password: 'merchant123', id: 'demo-merchant', display_name: 'My business' },
  developer: { email: 'developer@demo.lokmitra', password: 'developer123', id: 'demo-developer', display_name: 'Developer' },
} as const;

function mapSupabaseSession(session: Awaited<ReturnType<typeof getSupabaseSession>>): AuthSession | null {
  if (!session) return null;
  return {
    id: session.user.id,
    role: 'merchant',
    display_name: typeof session.user.user_metadata.display_name === 'string'
      ? session.user.user_metadata.display_name
      : 'My business',
    access_token: session.access_token,
  };
}

function getLocalDemoSession(): AuthSession | null {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (!stored) return null;
    const session = authSessionSchema.parse(JSON.parse(stored));
    return session.role === 'developer' || !isSupabaseConfigured ? session : null;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export const authService: AuthService = {
  async login(role, email, password) {
    if (role === 'merchant' && isSupabaseConfigured) {
      sessionStorage.removeItem(SESSION_KEY);
      const session = await signInAnonymously();
      const mapped = mapSupabaseSession(session);
      if (!mapped) throw new Error('Supabase did not return an authenticated user.');
      return mapped;
    }

    const account = demoUsers[role];
    if (email.trim().toLowerCase() !== account.email || password !== account.password) {
      throw new Error(`Email or password is not correct for this demo ${role} role.`);
    }
    if (role === 'developer' && isSupabaseConfigured) await signOutSupabase();
    const session = { id: account.id, role, display_name: account.display_name };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  },
  async logout() {
    sessionStorage.removeItem(SESSION_KEY);
    await signOutSupabase();
    await closeAllMerchantDatabases();
  },
  async getSession() {
    const localDemoSession = getLocalDemoSession();
    if (localDemoSession) return localDemoSession;
    if (!isSupabaseConfigured) return null;
    return mapSupabaseSession(await getSupabaseSession());
  },
  subscribe(callback) {
    return subscribeToSupabaseAuth((session) => {
      if (getLocalDemoSession()) return;
      callback(mapSupabaseSession(session));
    });
  },
};

export const demoCredentials = {
  merchant: { email: demoUsers.merchant.email, password: demoUsers.merchant.password },
  developer: { email: demoUsers.developer.email, password: demoUsers.developer.password },
} as const;
