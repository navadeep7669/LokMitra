import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Languages, Leaf, LockKeyhole } from 'lucide-react';
import { authService, demoCredentials, type AuthSession, type UserRole } from '../services/auth';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { getMessage, type UiLanguage } from '../i18n';

export type AuthContextValue = {
  session: AuthSession | null;
  ready: boolean;
  restoreError: string | null;
  login: (role: UserRole, email: string, password: string) => Promise<AuthSession>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const unsubscribe = authService.subscribe((nextSession) => {
      if (active) setSession(nextSession);
    });
    void authService.getSession().then((restored) => {
      if (active) setSession(restored);
    }).catch((issue: unknown) => {
      if (active) {
        setSession(null);
        setRestoreError(issue instanceof Error ? issue.message : 'Could not restore your session.');
      }
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const value = useMemo<AuthContextValue>(() => ({
    ready,
    session,
    restoreError,
    async login(role, email, password) {
      const result = await authService.login(role, email, password);
      setRestoreError(null);
      setSession(result);
      return result;
    },
    async logout() { await authService.logout(); setSession(null); },
  }), [ready, restoreError, session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider.');
  return value;
}
export function RequireRole({ role }: { role: UserRole }) {
  const { session, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <main aria-busy="true">Restoring your session…</main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.role !== role) return <Navigate to={session.role === 'merchant' ? '/app/dashboard' : '/dev/overview'} replace />;
  return <Outlet />;
}

export function LoginPage() {
  const [role, setRole] = useState<UserRole>('merchant');
  const [language, setLanguage] = useState<UiLanguage>('en');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { session, login, restoreError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = (key: Parameters<typeof getMessage>[1]) => getMessage(language, key);
  if (session) return <Navigate to={session.role === 'merchant' ? '/app/dashboard' : '/dev/overview'} replace />;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const authenticated = await login(role, email, password);
      navigate(authenticated.role === 'merchant' ? '/app/dashboard' : '/dev/overview', { replace: true, state: location.state });
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><div className="login-art"><div className="login-brand"><span className="brand-symbol"><span /></span><span>LokMitra <small>LOCAL BUSINESS, TOGETHER</small></span></div><div className="login-art-copy"><span className="login-kicker">LOCAL ROOTS. BIGGER REACH.</span><h1>{t('tagline')}</h1><p>ఒక చిన్న మాటతో మీ వ్యాపార లెక్కలు.</p><div className="login-art-pattern"><span>₹</span><span>✳</span><span>స</span></div></div><div className="login-art-footer">लोकमित्र · A companion for the work you do.</div></div><section className="login-panel"><div className="login-topline"><span><Leaf size={17} /> {t('app')}</span><label className="login-language"><Languages size={15} /><select aria-label={t('language')} value={language} onChange={(event) => setLanguage(event.target.value as UiLanguage)}><option value="en">English</option><option value="hi">हिन्दी</option><option value="te">తెలుగు</option></select></label></div><div className="login-form-wrap"><span className="eyebrow">WELCOME BACK</span><h2>{t('login')}</h2><p className="login-intro">Choose your workspace to continue.</p><div className="role-switch" role="group" aria-label={t('role')}><button type="button" className={role === 'merchant' ? 'selected' : ''} onClick={() => setRole('merchant')}>{t('merchant')}</button><button type="button" className={role === 'developer' ? 'selected' : ''} onClick={() => setRole('developer')}>{t('developer')}</button></div><form onSubmit={(event) => void submit(event)}>{role === 'merchant' && isSupabaseConfigured ? <p className="login-intro">Continue with a private anonymous Supabase session. Your local ledger stays available offline.</p> : <><label htmlFor="login-email">{t('email')}</label><input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /><label htmlFor="login-password">{t('password')}</label><div className="password-field"><LockKeyhole size={16} /><input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></div></>}{restoreError && <p role="alert" className="form-error">{restoreError}</p>}{error && <p role="alert" className="form-error">{error}</p>}<button className="button button-primary login-submit" disabled={busy}>{busy ? 'Signing in…' : role === 'merchant' && isSupabaseConfigured ? 'Continue as merchant' : t('continue')}</button></form>{import.meta.env.DEV && (!isSupabaseConfigured || role === 'developer') && <div className="demo-login-info"><b>Demo sign-in</b>{(!isSupabaseConfigured || role === 'developer') && <><span>Merchant · {demoCredentials.merchant.email}</span><code>{demoCredentials.merchant.password}</code></>}<span>Developer · {demoCredentials.developer.email}</span><code>{demoCredentials.developer.password}</code></div>}<p className="login-disclaimer">{role === 'merchant' && isSupabaseConfigured ? 'Sign-in creates a private Supabase identity for this browser.' : 'Local demo authentication only.'}</p></div><footer>LokMitra · <Link to="/login">Privacy-minded by design</Link></footer></section></main>;
}
