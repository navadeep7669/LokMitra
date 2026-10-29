import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  Headphones,
  Home,
  Languages,
  ListFilter,
  LogOut,
  Mic,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Users,
  Wallet,
  Wifi,
} from "lucide-react";
import { useAuth } from "../auth/Auth";
import {
  createMerchantRepository,
  type MerchantRepository,
} from "../data/repository";
import {
  balanceOwedPaise,
  customerSchema,
  effectiveEvents,
  eventsToCsv,
  parseVoiceIntent,
  paiseToRupees,
  rupeesToPaise,
  type Customer,
  type AppSettings,
  type EventType,
  type LanguageCode,
  type MerchantMembership,
  type Order,
  type TransactionEvent,
} from "../domain/events";
import { matchCustomerCandidates } from "../domain/customerMatching";
import { getMessage, type MessageKey, type UiLanguage } from "../i18n";
import {
  createInvoice,
  mockPaymentService,
  PLANS,
  type CheckoutSession,
} from "../services/billing";
import { localTranslationService } from "../services/translation";
import { mockSyncService, supabaseSyncService } from "../services/sync";
import { isSupabaseConfigured } from "../services/supabaseClient";
import { buildWhatsAppReminderUrl } from "../services/reminders";
import { aggregateDailyReport } from "../domain/reports";
import {
  createCloudSpeechProvider,
  createCloudTextToSpeechProvider,
  createCloudTranslationProvider,
} from "../services/cloudAssist";
import { encode16kMonoWav } from "../services/wav";
import {
  createWebSpeechProvider,
  recognitionLanguageFor,
} from "../services/speech";

const MerchantContext = createContext<MerchantState | null>(null);
type MerchantState = {
  merchantId: string;
  repository: MerchantRepository;
  customers: Customer[];
  events: TransactionEvent[];
  orders: Order[];
  membership: MerchantMembership;
  queue: Awaited<ReturnType<MerchantRepository["listSyncQueue"]>>;
  language: UiLanguage;
  settings: AppSettings;
  ready: boolean;
  speechEnabled: boolean;
  speechInputLanguage: LanguageCode;
  cloudAssistConsent: boolean;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  online: boolean;
  refresh: () => Promise<void>;
  setLanguage: (language: UiLanguage) => Promise<void>;
  setSpeechEnabled: (enabled: boolean) => Promise<void>;
  setSpeechInputLanguage: (language: LanguageCode) => Promise<void>;
  setCloudAssistConsent: (enabled: boolean) => Promise<void>;
  setMembership: (membership: MerchantMembership) => Promise<void>;
  notify: (message: string, tone?: "success" | "error") => void;
};
const merchantNav: Array<{ to: string; key: MessageKey; icon: typeof Home }> = [
  { to: "/app/dashboard", key: "overview", icon: Home },
  { to: "/app/voice", key: "voice", icon: Mic },
  { to: "/app/customers", key: "customers", icon: Users },
  { to: "/app/ledger", key: "ledger", icon: ListFilter },
  { to: "/app/dues", key: "dues", icon: Wallet },
  { to: "/app/orders", key: "orders", icon: ShoppingBag },
  { to: "/app/reports", key: "reports", icon: Activity },
  { to: "/app/membership", key: "membership", icon: ShieldCheck },
];
const money = paiseToRupees;
const dateShort = (value: number) =>
  new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
const typeLabels: Record<TransactionEvent["type"], string> = {
  credit_sale: "Credit sale",
  payment_received: "Payment received",
  refund: "Refund",
  payable: "Payable",
  reversal: "Reversal",
};

export function MerchantPortal() {
  const { session, logout } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  return (
    <MerchantProvider key={session.id} merchantId={session.id}>
      <MerchantFrame logout={() => void logout()}>
        <MerchantRoutes />
      </MerchantFrame>
    </MerchantProvider>
  );
}
function MerchantProvider({
  merchantId,
  children,
}: {
  merchantId: string;
  children: ReactNode;
}) {
  const repository = useMemo(
    () => createMerchantRepository(merchantId),
    [merchantId],
  );
  const defaultMembership = useMemo<MerchantMembership>(() => ({
    merchant_id: merchantId,
    plan_key: "free",
    speech_minutes_used: 0,
    period_start: new Date().toISOString().slice(0, 10),
  }), [merchantId]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<TransactionEvent[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [queue, setQueue] = useState<MerchantState["queue"]>([]);
  const [membership, setMembershipState] = useState<MerchantMembership>(defaultMembership);
  const [language, setLanguageState] = useState<UiLanguage>("en");
  const [speechEnabled, setSpeechEnabledState] = useState(false);
  const [speechInputLanguage, setSpeechInputLanguageState] =
    useState<LanguageCode>("en");
  const [cloudAssistConsent, setCloudAssistConsentState] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<{
    text: string;
    tone: "success" | "error";
  } | null>(null);
  const notify = useCallback(
    (text: string, tone: "success" | "error" = "success") =>
      setToast({ text, tone }),
    [],
  );
  const refresh = useCallback(async () => {
    const [
      nextCustomers,
      nextEvents,
      nextOrders,
      nextQueue,
      savedMembership,
      savedLanguage,
      savedSpeech,
      savedInputLanguage,
      savedCloudConsent,
      savedLastSyncAt,
      savedLastSyncError,
    ] = await Promise.all([
      repository.listCustomers(),
      repository.listEvents(),
      repository.listOrders(),
      repository.listSyncQueue(),
      repository.getMembership(),
      repository.getPreference("language"),
      repository.getPreference("speech-output"),
      repository.getPreference("speech-input-language"),
      repository.getPreference("cloud-assist-consent"),
      repository.getPreference("last-sync-at"),
      repository.getPreference("last-sync-error"),
    ]);
    setCustomers(nextCustomers);
    setEvents(nextEvents);
    setOrders(nextOrders);
    setQueue(nextQueue);
    if (savedMembership) setMembershipState(savedMembership);
    if (
      savedLanguage === "en" ||
      savedLanguage === "hi" ||
      savedLanguage === "te"
    )
      setLanguageState(savedLanguage);
    setSpeechEnabledState(savedSpeech === "true");
    setCloudAssistConsentState(savedCloudConsent === "true");
    const parsedSyncAt = savedLastSyncAt ? Number(savedLastSyncAt) : NaN;
    setLastSyncAt(Number.isFinite(parsedSyncAt) ? parsedSyncAt : null);
    setLastSyncError(savedLastSyncError || null);
    setReady(true);
    if (savedInputLanguage === "en" || savedInputLanguage === "hi" || savedInputLanguage === "te") {
      setSpeechInputLanguageState(savedInputLanguage);
    } else if (savedInputLanguage === "hinglish") {
      setSpeechInputLanguageState("te");
      await repository.setPreference("speech-input-language", "te");
    } else {
      setSpeechInputLanguageState(savedLanguage === "hi" || savedLanguage === "te" ? savedLanguage : "en");
    }
  }, [repository]);
  useEffect(() => {
    void repository
      .seedDemoData()
      .then(async () => {
        if (!(await repository.getMembership()))
          await repository.saveMembership(defaultMembership);
        await refresh();
      })
      .catch(() =>
        {
          setReady(true);
          notify("Could not open this merchant’s local database.", "error");
        },
      );
  }, [repository, defaultMembership, refresh, notify]);
  useEffect(() => {
    const onlineChange = () => setOnline(navigator.onLine);
    window.addEventListener("online", onlineChange);
    window.addEventListener("offline", onlineChange);
    return () => {
      window.removeEventListener("online", onlineChange);
      window.removeEventListener("offline", onlineChange);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  const setLanguage = async (value: UiLanguage) => {
    setLanguageState(value);
    await repository.setPreference("language", value);
    if (!(await repository.getPreference("speech-input-language"))) {
      setSpeechInputLanguageState(value);
    }
  };
  const setSpeechEnabled = async (value: boolean) => {
    setSpeechEnabledState(value);
    await repository.setPreference("speech-output", String(value));
  };
  const setSpeechInputLanguage = async (value: LanguageCode) => {
    const languageValue = value === "hinglish" ? "te" : value;
    setSpeechInputLanguageState(languageValue);
    await repository.setPreference("speech-input-language", languageValue);
  };
  const setCloudAssistConsent = async (value: boolean) => {
    setCloudAssistConsentState(value);
    await repository.setPreference("cloud-assist-consent", String(value));
  };
  const setMembership = async (value: MerchantMembership) => {
    setMembershipState(value);
    await repository.saveMembership(value);
  };
  const settings: AppSettings = {
    language,
    speech_output_enabled: speechEnabled,
    speech_input_language: speechInputLanguage,
    cloud_assist_consent: cloudAssistConsent,
    last_sync_at: lastSyncAt,
    last_sync_error: lastSyncError,
  };
  const value: MerchantState = {
    merchantId,
    repository,
    customers,
    events,
    orders,
    membership,
    queue,
    language,
    settings,
    ready,
    speechEnabled,
    speechInputLanguage,
    cloudAssistConsent,
    lastSyncAt,
    lastSyncError,
    online,
    refresh,
    setLanguage,
    setSpeechEnabled,
    setSpeechInputLanguage,
    setCloudAssistConsent,
    setMembership,
    notify,
  };
  return (
    <MerchantContext.Provider value={value}>
      {children}
      {toast && (
        <div
          role="status"
          className={`toast ${toast.tone === "error" ? "toast-error" : ""}`}
        >
          <Check size={17} />
          {toast.text}
        </div>
      )}
    </MerchantContext.Provider>
  );
}
function useMerchant() {
  const state = useContext(MerchantContext);
  if (!state) throw new Error("Merchant page requires MerchantProvider.");
  return state;
}
function MerchantRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<DashboardPage />} />
      <Route path="voice" element={<VoicePage />} />
      <Route path="customers" element={<CustomersPage />} />
      <Route path="customers/:id" element={<CustomerRouteGuard />} />
      <Route path="ledger" element={<LedgerPage />} />
      <Route path="dues" element={<DuesPage />} />
      <Route path="orders" element={<OrdersPage />} />
      <Route path="reports" element={<ReportsPage />} />
      <Route path="membership" element={<MembershipPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="*" element={<MerchantNotFound />} />
    </Routes>
  );
}
function CustomerRouteGuard() {
  const { id = "" } = useParams();
  const { customers, ready } = useMerchant();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return <EmptyState title="Not found" detail="This customer link is invalid." />;
  }
  if (!ready) return <p className="portal-loading">Loading customer ledger…</p>;
  const customer = customers.find((item) => item.id === id);
  if (!customer) return <EmptyState title="Not found" detail="This customer is not in the current merchant ledger." />;
  return <CustomerPage key={id} id={id} customer={customer} />;
}
function MerchantFrame({
  children,
  logout,
}: {
  children: ReactNode;
  logout: () => void;
}) {
  const { language, online, customers, events } = useMerchant();
  const t = (key: MessageKey) => getMessage(language, key);
  return (
    <div className="portal-shell merchant-shell">
      <aside className="portal-sidebar">
        <Link to="/app/dashboard" className="brand">
          <span className="brand-symbol">
            <span />
          </span>
          <span>
            <b>lokmitra</b>
            <small>LOCAL BUSINESS, TOGETHER</small>
          </span>
        </Link>
        <div className="workspace-label">
          {t("merchant")} <span className="demo-chip">DEMO</span>
        </div>
        <nav aria-label="Merchant navigation">
          {merchantNav.map(({ to, key, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `portal-nav-link ${isActive ? "active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{t(key)}</span>
              {key === "dues" && balanceOwedPaise(events) > 0 && (
                <span className="nav-count">
                  {
                    customers.filter(
                      (customer) => balanceOwedPaise(events, customer.id) > 0,
                    ).length
                  }
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="portal-sidebar-bottom">
          <NavLink
            to="/app/settings"
            className={({ isActive }) =>
              `portal-nav-link ${isActive ? "active" : ""}`
            }
          >
            <Settings size={18} />
            <span>{t("settings")}</span>
          </NavLink>
          <button className="portal-nav-link logout-button" onClick={logout}>
            <LogOut size={18} />
            <span>{t("logout")}</span>
          </button>
        </div>
      </aside>
      <header className="portal-topbar">
        <span className="portal-workspace">
          LokMitra <i>/</i> Merchant portal
        </span>
        <span className={`connection ${online ? "is-online" : "is-offline"}`}>
          <i />
          {t(online ? "online" : "offline")}
        </span>
        <span className="topbar-demo">{t("localOnly")}</span>
      </header>
      <main className="portal-content">{children}</main>
      <nav className="merchant-bottom-nav" aria-label="Mobile navigation">
        {merchantNav.slice(0, 5).map(({ to, key, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={t(key)}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon size={19} />
            <small>{t(key)}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
function Heading({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
}) {
  return (
    <div className="portal-heading">
      <div>
        <h1>{title}</h1>
        {note && <p>{note}</p>}
      </div>
      {action}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  tone = "",
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <section className="portal-metric">
      <span className={`metric-glyph ${tone}`}>
        <Activity size={17} />
      </span>
      <small>{label}</small>
      <b>{value}</b>
      <span>{note}</span>
    </section>
  );
}
function DashboardPage() {
  const { customers, events, orders, language } = useMerchant();
  const t = (key: MessageKey) => getMessage(language, key);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const current = effectiveEvents(events).filter(
    (event) => event.occurred_at >= today.getTime(),
  );
  const credit = current
    .filter((event) => event.type === "credit_sale")
    .reduce((sum, event) => sum + event.amount_paise, 0);
  const received = current
    .filter((event) => event.type === "payment_received")
    .reduce((sum, event) => sum + event.amount_paise, 0);
  const busyOrders = orders.filter(
    (order) => order.status === "New" || order.status === "In Progress",
  ).length;
  return (
    <>
      <section className="portal-welcome">
        <span>
          {t("demo")} ·{" "}
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </span>
        <h1>{t("dashboardTitle")}</h1>
        <p>{t("tagline")}</p>
        <Link className="button button-mint" to="/app/voice">
          <Mic size={19} /> Open voice ledger <ChevronRight size={17} />
        </Link>
        <span className="welcome-script">లోకమిత్ర</span>
      </section>
      <div className="portal-metrics">
        <Metric
          label={t("received")}
          value={money(received)}
          note="Event-based · not a bank verification"
          tone="positive"
        />
        <Metric
          label={t("credit")}
          value={money(credit)}
          note="Confirmed credit_sale events"
          tone="warning"
        />
        <Metric
          label={t("outstanding")}
          value={money(balanceOwedPaise(events))}
          note="Credit sales less payments received"
          tone="due"
        />
        <Metric
          label={t("activeCustomers")}
          value={String(customers.length)}
          note={`${busyOrders} orders need attention`}
          tone="mint"
        />
      </div>
      <div className="portal-columns">
        <section className="portal-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Recent ledger events</h2>
              <p>
                {events.length} {t("entries")} · local records
              </p>
            </div>
            <Link to="/app/ledger">
              View ledger <ChevronRight size={15} />
            </Link>
          </div>
          {events.slice(0, 6).map((event) => (
            <EventRow
              key={event.id}
              event={event}
              customer={customers.find((item) => item.id === event.customer_id)}
            />
          ))}
        </section>
        <section className="portal-panel quick-tile-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Quick actions</h2>
              <p>Keep today moving</p>
            </div>
          </div>
          <div className="quick-tile-grid">
            <Link to="/app/customers">
              <Users size={19} />
              <b>{t("addCustomer")}</b>
            </Link>
            <Link to="/app/voice">
              <Mic size={19} />
              <b>Record an event</b>
            </Link>
            <Link to="/app/orders">
              <ShoppingBag size={19} />
              <b>Create an order</b>
            </Link>
            <Link to="/app/dues">
              <Bell size={19} />
              <b>Share a reminder</b>
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
function EventRow({
  event,
  customer,
}: {
  event: TransactionEvent;
  customer?: Customer;
}) {
  return (
    <div className="event-row">
      <span className={`event-glyph event-${event.type}`} />{" "}
      <div className="event-label">
        <b>{customer?.display_name ?? "Customer"}</b>
        <span>
          {event.note || typeLabels[event.type]} · {typeLabels[event.type]}
        </span>
      </div>
      <div className="event-value">
        <b>{money(event.amount_paise)}</b>
        <small>{dateShort(event.occurred_at)}</small>
      </div>
    </div>
  );
}
function VoicePage() {
  const { session } = useAuth();
  const {
    customers,
    events,
    repository,
    membership,
    setMembership,
    speechEnabled,
    speechInputLanguage,
    setSpeechInputLanguage,
    cloudAssistConsent,
    online,
    language,
    notify,
    refresh,
  } = useMerchant();
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<ReturnType<
    typeof parseVoiceIntent
  > | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerListOpen, setCustomerListOpen] = useState(false);
  const [activeCustomerOption, setActiveCustomerOption] = useState(0);
  const [addingVoiceCustomer, setAddingVoiceCustomer] = useState(false);
  const [newVoiceCustomerName, setNewVoiceCustomerName] = useState("");
  const [newVoiceCustomerPhone, setNewVoiceCustomerPhone] = useState("");
  const [newVoiceCustomerLanguage, setNewVoiceCustomerLanguage] = useState<"en" | "hi" | "te" | "">("");
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [amount, setAmount] = useState("");
  const amountInputRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<"credit_sale" | "payment_received" | "">("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<
    "idle" | "listening" | "processing" | "error"
  >("idle");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [undoableEvent, setUndoableEvent] = useState<TransactionEvent | null>(null);
  const savingRef = useRef(false);
  const [speechSource, setSpeechSource] = useState(false);
  const [translationLanguage, setTranslationLanguage] =
    useState<LanguageCode>("en");
  const [cloudSpeechUsed, setCloudSpeechUsed] = useState(false);
  const [cloudTranslation, setCloudTranslation] = useState("");
  const [cloudTranslationBusy, setCloudTranslationBusy] = useState(false);
  const [parseFailureCount, setParseFailureCount] = useState(0);
  const customerMatches = useMemo(() => matchCustomerCandidates(customerQuery, customers), [customerQuery, customers]);
  const plan =
    PLANS.find((item) => item.key === membership.plan_key) ?? PLANS[0];
  const micExhausted = membership.speech_minutes_used >= plan.speech_minutes;
  const translation = localTranslationService.translate(
    transcript,
    language,
    translationLanguage,
  );
  useEffect(() => {
    let active = true;
    void repository.getPreference("voice-debug-enabled").then((value) => {
      if (active) setDebugEnabled(value === "true");
    }).catch((issue: unknown) => notify(issue instanceof Error ? issue.message : "Could not load parser settings.", "error"));
    return () => { active = false; };
  }, [repository, notify]);
  useEffect(() => {
    if (!undoableEvent) return;
    const timeout = window.setTimeout(() => setUndoableEvent(null), 30_000);
    return () => window.clearTimeout(timeout);
  }, [undoableEvent]);
  const parse = (value: string, fromSpeech = false) => {
    setTranscript(value);
    setSpeechSource(fromSpeech);
    const result = parseVoiceIntent(value, customers);
    setParsed(result);
    setCustomerId(result.customer_id);
    setCustomerQuery(result.customer_id
      ? customers.find((customer) => customer.id === result.customer_id)?.display_name ?? result.customer_query
      : result.customer_query);
    setCustomerListOpen(Boolean(result.customer_query));
    setActiveCustomerOption(0);
    setAmount(result.amount_paise ? String(result.amount_paise / 100) : "");
    setType(result.type ?? "");
    setNote(value.trim());
    if (fromSpeech && result.clarification.length > 0) setParseFailureCount((count) => count + 1);
    else if (!fromSpeech || result.clarification.length === 0) setParseFailureCount(0);
    if (!fromSpeech) setCloudSpeechUsed(false);
    if (value.trim()) setCloudTranslation("");
    if (fromSpeech && !result.amount_paise && !result.is_pending_query) {
      window.requestAnimationFrame(() => amountInputRef.current?.focus());
    }
  };
  const selectVoiceCustomer = (customer: Customer) => {
    setCustomerId(customer.id);
    setCustomerQuery(customer.display_name);
    setCustomerListOpen(false);
  };
  const addVoiceCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedCustomer = customerSchema.safeParse({
      display_name: newVoiceCustomerName,
      phone: newVoiceCustomerPhone,
      language: newVoiceCustomerLanguage || undefined,
    });
    if (!parsedCustomer.success) {
      setError(parsedCustomer.error.issues[0]?.message ?? "Check customer details.");
      return;
    }
    try {
      const customer = await repository.createCustomer(parsedCustomer.data);
      await refresh();
      selectVoiceCustomer(customer);
      setAddingVoiceCustomer(false);
      setNewVoiceCustomerName("");
      setNewVoiceCustomerPhone("");
      setNewVoiceCustomerLanguage("");
      setError("");
      notify(getMessage(language, "customerAddedDraft"));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not add customer.");
    }
  };
  const captureCloudSpeech = async () => {
    if (!cloudAssistConsent) {
      setError("Enable cloud-assist consent in settings before sending audio.");
      return;
    }
    if (!online) {
      setError("Cloud speech is unavailable offline. Type your words below.");
      return;
    }
    if (!session?.access_token) {
      setError("Cloud speech requires a verified sign-in session. Type your words below.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Audio recording is not supported in this browser. Type your words below.");
      return;
    }
    let stream: MediaStream | undefined;
    let audioContext: AudioContext | undefined;
    setState("listening");
    setError("");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const recorder = new MediaRecorder(stream);
      const audioBlob = await new Promise<Blob>((resolve, reject) => {
        const chunks: Blob[] = [];
        const timeout = window.setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, 5000);
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("Audio recording failed."));
        };
        recorder.onstop = () => {
          window.clearTimeout(timeout);
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.start();
      });
      if (!audioBlob.size) throw new Error("No audio was recorded. Try again or type your words.");
      setState("processing");
      audioContext = new AudioContext();
      const audioBuffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
      const wavAudio = encode16kMonoWav(audioBuffer);
      const cloudTranscript = await createCloudSpeechProvider().transcribe(wavAudio, speechInputLanguage, {
        consent: cloudAssistConsent,
        online,
        accessToken: session.access_token,
      });
      setCloudSpeechUsed(true);
      setParseFailureCount(0);
      parse(cloudTranscript, true);
      setError("");
    } catch (issue) {
      setState("error");
      setError(issue instanceof Error ? issue.message : "Cloud speech failed. Type your words below.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (audioContext) await audioContext.close();
      setState((current) => current === "error" ? current : "idle");
    }
  };
  const startSpeech = () => {
    if (micExhausted) {
      notify(
        "Speech minutes are used up for this plan. Upgrade to continue.",
        "error",
      );
      return;
    }
    const speechProvider = createWebSpeechProvider();
    if (!speechProvider.isSupported()) {
      setState("error");
      if (cloudAssistConsent && online) {
        void captureCloudSpeech();
        return;
      }
      setError(
        "Speech input is not supported in this browser. Type your words below.",
      );
      return;
    }
    const recognitionLanguage = recognitionLanguageFor(speechInputLanguage);
    setState("listening");
    setError("");
    void speechProvider.listen(recognitionLanguage).then((value) => {
      setState("processing");
      setCloudSpeechUsed(false);
      parse(value, true);
      setState("idle");
    }).catch((issue: unknown) => {
      setState("error");
      setError(`${issue instanceof Error ? issue.message : "Speech recognition failed."} Type your words below.`);
    });
  };
  const save = async () => {
    if (savingRef.current) return;
    const amountPaise = rupeesToPaise(amount);
    if (!customerId || !amountPaise || !type) {
      setError("Choose a customer, amount, and event type before confirming.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    const timestamp = Date.now();
    try {
      const savedEvent: TransactionEvent = {
        id: crypto.randomUUID(),
        customer_id: customerId,
        type,
        amount_paise: amountPaise,
        note: note.slice(0, 500),
        occurred_at: timestamp,
        client_timestamp: timestamp,
        transcript_raw: transcript.slice(0, 2000),
        speech_usage: speechSource ? cloudSpeechUsed ? "local_stt" : "browser_speech" : "manual",
        confirmed_by_user: true,
        created_at: timestamp,
        sync_status: "pending",
        is_demo: false,
      };
      await repository.createEvent(savedEvent);
      setUndoableEvent(savedEvent);
      if (speechSource)
        await setMembership({
          ...membership,
          speech_minutes_used: Math.min(
            plan.speech_minutes,
            membership.speech_minutes_used + 1,
          ),
        });
      await refresh();
      setConfirming(false);
      setTranscript("");
      setParsed(null);
      setAmount("");
      setType("");
      setCustomerId("");
      setNote("");
      setState("idle");
      notify("Event saved to this merchant’s local ledger.");
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not save this event.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const undoLastEvent = async () => {
    if (!undoableEvent) return;
    try {
      await repository.reverseEvent(undoableEvent.customer_id, undoableEvent.id, true);
      setUndoableEvent(null);
      await refresh();
      notify("Event voided with an append-only reversal.");
    } catch (issue) {
      notify(issue instanceof Error ? issue.message : "Could not undo this event.", "error");
    }
  };
  const readBack = async () => {
    if (!speechEnabled || !("speechSynthesis" in window)) {
      notify("Enable spoken confirmation in settings first.", "error");
      return;
    }
    const customer = customers.find((item) => item.id === customerId);
    const phrase = `${customer?.display_name ?? "Customer"} account: ${money(rupeesToPaise(amount) ?? 0)} ${type === "credit_sale" ? "pending" : "received"}`;
    if (cloudAssistConsent && online && session?.access_token) {
      setState("processing");
      try {
        const audio = await createCloudTextToSpeechProvider().synthesize(phrase, speechInputLanguage, {
          consent: cloudAssistConsent,
          online,
          accessToken: session.access_token,
        });
        const audioUrl = URL.createObjectURL(audio);
        const player = new Audio(audioUrl);
        player.onended = () => URL.revokeObjectURL(audioUrl);
        player.onerror = () => URL.revokeObjectURL(audioUrl);
        await player.play();
        return;
      } catch (issue) {
        setError(issue instanceof Error ? issue.message : "Speech playback failed.");
        return;
      } finally {
        setState("idle");
      }
    }
    const utterance = new SpeechSynthesisUtterance(phrase);
    const prefix =
      speechInputLanguage === "te"
        ? "te"
        : speechInputLanguage === "hi"
          ? "hi"
          : "en";
    utterance.voice =
      window.speechSynthesis
        .getVoices()
        .find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ?? null;
    window.speechSynthesis.speak(utterance);
  };
  const targetCustomer = customers.find(
    (customer) => customer.id === customerId,
  );
  const targetBalance = targetCustomer
    ? balanceOwedPaise(events, targetCustomer.id)
    : 0;
  return (
    <>
      <Heading
        title="Voice ledger"
        note="Speech recognition may require internet. Local parsing is approximate; review every field before saving."
      />
      <div className="voice-page-grid">
        <section className="voice-capture portal-panel">
          <div className="voice-status" aria-live="polite">
            <span className={`voice-indicator ${state}`} />{" "}
            {state === "listening"
              ? "Listening…"
              : state === "processing"
                ? "Processing speech…"
                : state === "error"
                  ? "Input needs attention"
                  : "Ready when you are"}
          </div>
          {cloudSpeechUsed && <p className="review-chip" role="status">Cloud speech used · machine generated</p>}
          <div className="voice-mic-area">
            <div className="voice-mic-language">
              <button
                className={`portal-mic ${state === "listening" ? "listening" : ""}`}
                aria-label="Start speech input"
                disabled={micExhausted || state === "listening"}
                onClick={startSpeech}
              >
                <Mic size={30} />
              </button>
              <div className="speech-language-switch" role="group" aria-label="Speech input language">
                {([
                  ["te", getMessage(language, "speechTelugu"), "te-IN"],
                  ["hi", getMessage(language, "speechHindi"), "hi-IN"],
                  ["en", getMessage(language, "speechEnglish"), "en-IN"],
                ] as const).map(([code, label, locale]) => (
                  <button
                    key={code}
                    type="button"
                    className={speechInputLanguage === code ? "selected" : ""}
                    aria-pressed={speechInputLanguage === code}
                    onClick={() => void setSpeechInputLanguage(code)}
                  >
                    {label}<small>{locale}</small>
                  </button>
                ))}
              </div>
            </div>
              {cloudAssistConsent && online && session?.access_token && (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window) || parseFailureCount >= 2 || state === "error") && (
                <button type="button" className="button button-outline" disabled={state === "listening" || state === "processing"} onClick={() => void captureCloudSpeech()}>
                  {state === "error" ? "Try cloud speech instead" : "Improve accuracy with cloud"}
                </button>
              )}
            <h2>What happened today?</h2>
            <p>Speak naturally, or type the phrase below.</p>
            <div className="speech-usage">
              {membership.speech_minutes_used} / {plan.speech_minutes} speech
              minutes this month
              {micExhausted && <Link to="/app/membership">Upgrade plan</Link>}
            </div>
          </div>
          <label className="field-label" htmlFor="voice-transcript">
            Original transcript
          </label>
          <textarea
            id="voice-transcript"
            rows={3}
            value={transcript}
            onChange={(event) => parse(event.target.value)}
            placeholder="Ravi nunchi 500 rupees vachayi"
          />
          <div className="phrase-examples">
            <button onClick={() => parse("Ravi nunchi 500 rupees vachayi")}>
              Ravi nunchi 500 rupees vachayi
            </button>
            <button onClick={() => parse("Sita ko पाँच सौ रुपये उधार दिया")}>
              Sita ko पाँच सौ रुपये उधार दिया
            </button>
          </div>
          <div className="translation-panel">
            <div className="translation-head">
              <b>Approximate local translation</b>
              <select
                aria-label="Translation language"
                value={translationLanguage}
                onChange={(event) =>
                  setTranslationLanguage(event.target.value as LanguageCode)
                }
              >
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
                <option value="te">తెలుగు</option>
                <option value="hinglish">Tenglish</option>
              </select>
            </div>
            <div className="translation-sides">
              <p>
                <small>Original</small>
                {transcript || "Transcript will appear here."}
              </p>
              <p>
                <small>
                  {cloudTranslation ? "Machine translated · cloud" : `Approximate · ${translation.provider === "stub" ? "no local phrase match" : "local phrase dictionary"}`}
                </small>
                {cloudTranslation || translation.text || "Translation preview will appear here."}
              </p>
            </div>
            {cloudAssistConsent && online && transcript.trim() && (
              <button type="button" className="button button-outline" disabled={cloudTranslationBusy || !session?.access_token} onClick={() => {
                setCloudTranslationBusy(true);
                void createCloudTranslationProvider().translateCloud(transcript, language, translationLanguage, {
                  consent: cloudAssistConsent,
                  online,
                  accessToken: session?.access_token,
                }).then(setCloudTranslation).catch((issue: unknown) => setError(issue instanceof Error ? issue.message : "Cloud translation failed.")).finally(() => setCloudTranslationBusy(false));
              }}>
                {cloudTranslationBusy ? "Translating…" : "Translate with cloud"}
              </button>
            )}
          </div>
        </section>
        <section className="portal-panel voice-review" aria-live="polite">
          <div className="portal-panel-heading">
            <div>
              <h2>Review before saving</h2>
              <p>Voice never saves an event directly.</p>
            </div>
            <span className="review-chip">
              {parsed?.clarification.length
                ? "Needs details"
                : parsed
                  ? "Review"
                  : "Draft"}
            </span>
          </div>
          {parsed?.is_pending_query && (
            <div className="pending-query">
              {targetCustomer
                ? `${targetCustomer.display_name}: ${money(targetBalance)} pending`
                : "Open your dues list to review outstanding balances."}
              <Link
                to={
                  targetCustomer
                    ? `/app/customers/${targetCustomer.id}`
                    : "/app/dues"
                }
              >
                View balance
              </Link>
            </div>
          )}
          <label className="field-label" htmlFor="voice-customer">
            Customer
          </label>
          <div className="customer-combobox">
          <input
            id="voice-customer"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={customerListOpen && customerQuery.length > 0}
            aria-controls="voice-customer-options"
            aria-activedescendant={customerListOpen && customerMatches[activeCustomerOption] ? `voice-customer-option-${customerMatches[activeCustomerOption].customer.id}` : undefined}
            autoComplete="off"
            value={customerQuery}
            placeholder={getMessage(language, "typeCustomerName")}
            onFocus={() => setCustomerListOpen(Boolean(customerQuery))}
            onChange={(event) => {
              setCustomerQuery(event.target.value);
              setCustomerId("");
              setCustomerListOpen(true);
              setActiveCustomerOption(0);
              setAddingVoiceCustomer(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && customerMatches.length) {
                event.preventDefault();
                setCustomerListOpen(true);
                setActiveCustomerOption((index) => (index + 1) % customerMatches.length);
              } else if (event.key === "ArrowUp" && customerMatches.length) {
                event.preventDefault();
                setActiveCustomerOption((index) => (index - 1 + customerMatches.length) % customerMatches.length);
              } else if (event.key === "Enter" && customerListOpen && customerMatches[activeCustomerOption]) {
                event.preventDefault();
                selectVoiceCustomer(customerMatches[activeCustomerOption].customer);
              } else if (event.key === "Escape") {
                setCustomerListOpen(false);
              }
            }}
          />
          {customerListOpen && customerQuery.trim() && (
            <ul id="voice-customer-options" role="listbox" className="customer-combobox-options">
              {customerMatches.map(({ customer, score }, index) => (
                <li
                  id={`voice-customer-option-${customer.id}`}
                  key={customer.id}
                  role="option"
                  aria-selected={customer.id === customerId}
                  className={index === activeCustomerOption ? "active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectVoiceCustomer(customer)}
                >
                  <span>{customer.display_name}</span>
                  <small>{Math.round(score * 100)}%</small>
                </li>
              ))}
              {!customerMatches.length && (
                <li className="customer-combobox-empty">{getMessage(language, "noCustomerFound")} “{customerQuery}”</li>
              )}
            </ul>
          )}
          {customerQuery.trim() && !customerMatches.length && !addingVoiceCustomer && (
            <button type="button" className="button button-outline customer-add-match" onClick={() => {
              setNewVoiceCustomerName(customerQuery.trim());
              setNewVoiceCustomerPhone("");
              setNewVoiceCustomerLanguage("");
              setAddingVoiceCustomer(true);
            }}>
              <Plus size={15} /> {getMessage(language, "addAsNewCustomer")} “{customerQuery.trim()}”
            </button>
          )}
          {addingVoiceCustomer && (
            <form className="voice-customer-create" onSubmit={(event) => void addVoiceCustomer(event)}>
              <label className="field-label" htmlFor="voice-new-customer-name">{getMessage(language, "newCustomerName")}</label>
              <input id="voice-new-customer-name" required maxLength={80} value={newVoiceCustomerName} onChange={(event) => setNewVoiceCustomerName(event.target.value)} />
              <label className="field-label" htmlFor="voice-new-customer-phone">{getMessage(language, "optionalPhone")}</label>
              <input id="voice-new-customer-phone" maxLength={24} inputMode="tel" value={newVoiceCustomerPhone} onChange={(event) => setNewVoiceCustomerPhone(event.target.value)} />
              <label className="field-label" htmlFor="voice-new-customer-language">{getMessage(language, "customerLanguage")}</label>
              <select id="voice-new-customer-language" value={newVoiceCustomerLanguage} onChange={(event) => setNewVoiceCustomerLanguage(event.target.value as typeof newVoiceCustomerLanguage)}>
                <option value="">—</option>
                <option value="te">{getMessage(language, "speechTelugu")}</option>
                <option value="hi">{getMessage(language, "speechHindi")}</option>
                <option value="en">{getMessage(language, "speechEnglish")}</option>
              </select>
              <div className="inline-form-actions">
                <button type="button" className="button button-quiet" onClick={() => setAddingVoiceCustomer(false)}>{getMessage(language, "cancel")}</button>
                <button type="submit" className="button button-primary">{getMessage(language, "addCustomer")}</button>
              </div>
            </form>
          )}
          </div>
          {parsed?.understood.length ? (
            <div className="voice-understood" aria-label={getMessage(language, "heardUnderstood")}>
              {parsed.understood.map((item, index) => (
                <span key={`${item.heard}-${index}`} className="heard-understood-chip">
                  {item.heard} → {item.understood} <small>{Math.round(item.confidence * 100)}% {getMessage(language, "confidence")}</small>
                </span>
              ))}
            </div>
          ) : null}
          <label className="field-label" htmlFor="voice-amount">
            Amount · INR
          </label>
          <div className="rupees-field">
            <span>₹</span>
            <input
              id="voice-amount"
              ref={amountInputRef}
              inputMode="decimal"
              aria-invalid={Boolean(parsed && !parsed.amount_paise)}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
            />
          </div>
          {parsed && !parsed.amount_paise && (
            <p className="amount-assist-hint" role={parsed.amount_ambiguous ? "alert" : undefined}>
              {getMessage(language, parsed.amount_ambiguous ? "amountAmbiguousHint" : "amountMissingHint")}
            </p>
          )}
          <span className="field-label">Event type</span>
          <div className="event-type-switch">
            <button
              className={type === "payment_received" ? "selected" : ""}
              onClick={() => setType("payment_received")}
            >
              <ArrowDownLeft size={16} /> Payment received
            </button>
            <button
              className={type === "credit_sale" ? "selected" : ""}
              onClick={() => setType("credit_sale")}
            >
              <ArrowUpRight size={16} /> Credit sale
            </button>
          </div>
          <label className="field-label" htmlFor="voice-note">
            Note
          </label>
          <input
            id="voice-note"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Short note about this event"
          />
          {parsed && (
            <p className="clarification-note">
              {parsed.clarification.join(" ") ||
                "Check the details before saving."}
            </p>
          )}
          {import.meta.env.DEV && debugEnabled && parsed && (
            <details className="voice-parser-debug">
              <summary>{getMessage(language, "parserDebug")}</summary>
              <div><b>Tokens</b><code>{parsed.debug.tokens.join(" · ") || "—"}</code></div>
              <div><b>Matched lexicon entries</b><code>{parsed.debug.matched_lexicon_entries.join(" · ") || "—"}</code></div>
              <div><b>Customer scores</b><code>{parsed.debug.customer_scores.map((entry) => `${entry.name}: ${Math.round(entry.score * 100)}%`).join(" · ") || "—"}</code></div>
            </details>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button
            className="button button-primary button-full"
            disabled={saving || !customerId || !rupeesToPaise(amount) || !type}
            onClick={() => setConfirming(true)}
          >
            <ShieldCheck size={17} /> Review and confirm
          </button>
          <button
            className="button button-outline button-full"
            disabled={
              !customerId || !rupeesToPaise(amount) || !type || !speechEnabled
            }
            onClick={readBack}
          >
            <Headphones size={16} /> Read back
          </button>
          <p className="privacy-caption">
            <ShieldCheck size={14} /> Original transcript stays in this
            merchant’s local database.
          </p>
        </section>
      </div>
      <section className="portal-panel recent-events">
        <div className="portal-panel-heading">
          <div>
            <h2>Recent voice events</h2>
            <p>Events created with speech or typed transcript</p>
          </div>
        </div>
        {events
          .filter((event) => event.speech_usage === "browser_speech")
          .slice(0, 5)
          .map((event) => (
            <EventRow
              key={event.id}
              event={event}
              customer={customers.find((item) => item.id === event.customer_id)}
            />
          ))}
      </section>
      {undoableEvent && (
        <div className="pending-query" role="status">
          Event saved locally. You can undo it for 30 seconds.
          <button type="button" className="button button-outline" onClick={() => void undoLastEvent()}>Undo</button>
        </div>
      )}
      {confirming && (
        <Modal title="Confirm this event" onCancel={() => setConfirming(false)}>
          <p className="modal-description">
            This creates one append-only event after your confirmation.
          </p>
          <div className="confirm-event-summary">
            <span>Customer</span>
            <b>{targetCustomer?.display_name}</b>
            <span>Type</span>
            <b>{typeLabels[type as EventType]}</b>
            <span>Amount</span>
            <b>{money(rupeesToPaise(amount) ?? 0)}</b>
            <span>Original transcript</span>
            <b>{transcript}</b>
          </div>
          <div className="modal-actions">
            <button
              className="button button-quiet"
              onClick={() => setConfirming(false)}
            >
              Edit / cancel
            </button>
            <button
              className="button button-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Confirm and save"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function CustomersPage() {
  const {
    customers,
    events,
    repository,
    refresh,
    notify,
    membership,
    language,
  } = useMerchant();
  const [search, setSearch] = useState("");
  const [balanceFilter, setBalanceFilter] = useState<"all" | "dues" | "settled">("all");
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const plan =
    PLANS.find((item) => item.key === membership.plan_key) ?? PLANS[0];
  const full = customers.length >= plan.customer_limit;
  const filtered = customers.filter((customer) =>
    `${customer.display_name} ${customer.phone}`.toLowerCase().includes(search.toLowerCase()) &&
    (balanceFilter === "all" ||
      (balanceFilter === "dues" && balanceOwedPaise(events, customer.id) > 0) ||
      (balanceFilter === "settled" && balanceOwedPaise(events, customer.id) <= 0)),
  );
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = customerSchema.safeParse({
      display_name: form.get("display_name"),
      phone: form.get("phone"),
      aliases: String(form.get("aliases") ?? "").split(/[,;\n]/).map((alias) => alias.trim()).filter(Boolean),
      language: form.get("language") || undefined,
    });
    if (!parsed.success) {
      notify(
        parsed.error.issues[0]?.message ?? "Check customer details.",
        "error",
      );
      return;
    }
    try {
      const customer = await repository.createCustomer(parsed.data);
      await refresh();
      setAdding(false);
      navigate(`/app/customers/${customer.id}`);
    } catch (issue) {
      notify(
        issue instanceof Error ? issue.message : "Could not add customer.",
        "error",
      );
    }
  };
  return (
    <>
      <Heading
        title={getMessage(language, "customers")}
        note="Contacts in your ledger. Customers do not sign in."
        action={
          <button
            className="button button-primary"
            disabled={full}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} /> Add customer
          </button>
        }
      />
      <div className="portal-toolbar">
        <label className="portal-search">
          <Search size={16} />
          <input
            aria-label="Search customers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or phone"
          />
        </label>
        <select aria-label="Filter customers by balance" value={balanceFilter} onChange={(event) => setBalanceFilter(event.target.value as typeof balanceFilter)}>
          <option value="all">All balances</option>
          <option value="dues">With dues</option>
          <option value="settled">Settled / credit</option>
        </select>
        <span>
          {filtered.length} customers
          {full ? ` · ${plan.name} limit reached` : ""}
        </span>
      </div>
      <div className="portal-list">
        {filtered.map((customer) => {
          const balance = balanceOwedPaise(events, customer.id);
          return (
            <Link
              key={customer.id}
              to={`/app/customers/${customer.id}`}
              className="customer-list-row"
            >
              <span className="customer-avatar">
                {customer.display_name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")}
              </span>
              <span className="customer-list-name">
                <b>{customer.display_name}</b>
                <small>{customer.phone || "No phone number"}</small>
              </span>
              <span className="customer-balance">
                <b>{money(Math.abs(balance))}</b>
                <small className={balance > 0 ? "status-due" : "status-ok"}>
                  {balance > 0
                    ? "Owes you"
                    : balance < 0
                      ? "Customer credit"
                      : "Settled"}
                </small>
              </span>
              <ChevronRight size={17} />
            </Link>
          );
        })}
        {!filtered.length && (
          <EmptyState
            title="No matching customers"
            detail="Try another search or add your first customer."
          />
        )}
      </div>
      {adding && (
        <Modal title="Add a customer" onCancel={() => setAdding(false)}>
          <form onSubmit={(event) => void add(event)}>
            <label className="field-label" htmlFor="customer-name">
              Display name
            </label>
            <input
              id="customer-name"
              name="display_name"
              required
              maxLength={80}
              autoFocus
            />
            <label className="field-label" htmlFor="customer-phone">
              Phone number <span>Optional</span>
            </label>
            <input
              id="customer-phone"
              name="phone"
              maxLength={24}
              inputMode="tel"
            />
            <label className="field-label" htmlFor="customer-aliases">{getMessage(language, "alsoCalled")} <span>{getMessage(language, "optionalAliasesHelp")}</span></label>
            <input id="customer-aliases" name="aliases" maxLength={500} />
            <label className="field-label" htmlFor="customer-language">{getMessage(language, "customerLanguage")}</label>
            <select id="customer-language" name="language" defaultValue="">
              <option value="">—</option>
              <option value="te">{getMessage(language, "speechTelugu")}</option>
              <option value="hi">{getMessage(language, "speechHindi")}</option>
              <option value="en">{getMessage(language, "speechEnglish")}</option>
            </select>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button className="button button-primary">Save customer</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function CustomerPage({ id, customer }: { id: string; customer: Customer }) {
  const { repository, events, refresh, notify, language } = useMerchant();
  const [loading, setLoading] = useState(true);
  const [customerEvents, setCustomerEvents] = useState<TransactionEvent[]>([]);
  const [reversalCandidate, setReversalCandidate] = useState<TransactionEvent | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void repository
      .eventsForCustomer(id)
      .then((rows) => {
        if (active) setCustomerEvents(rows);
      })
      .catch((issue: unknown) => {
        if (active) notify(issue instanceof Error ? issue.message : "Could not load this customer ledger.", "error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, repository, events, notify]);
  if (loading)
    return <p className="portal-loading">Loading customer ledger…</p>;
  const reversalTargets = new Set(
    customerEvents
      .filter((event) => event.type === "reversal")
      .map((event) => event.reverses_id),
  );
  const reverse = async () => {
    if (!reversalCandidate) return;
    try {
      await repository.reverseEvent(customer.id, reversalCandidate.id, true);
      await refresh();
      notify("Reversal added to the event ledger.");
      setReversalCandidate(null);
    } catch (issue) {
      notify(
        issue instanceof Error
          ? issue.message
          : "Could not reverse this event.",
        "error",
      );
    }
  };
  return (
    <>
      <Link to="/app/customers" className="back-to-list">
        <ArrowLeft size={15} /> Customers
      </Link>
      <Heading
        title={customer.display_name}
        note={customer.phone || "No phone number"}
        action={
          <>
            <button className="button button-outline" onClick={() => setEditing(true)}>Edit profile</button>
            <button className="button button-outline" onClick={() => openWhatsApp(customer, balanceOwedPaise(customerEvents, customer.id), language)}>
              <Bell size={16} /> Reminder
            </button>
          </>
        }
      />
      <div className="customer-detail-balance">
        <small>Balance owed</small>
        <b>{money(balanceOwedPaise(customerEvents, customer.id))}</b>
        <span>
          Credit sale less payments received. Refunds and payables are separate.
        </span>
      </div>
      <section className="portal-panel detail-events">
        <div className="portal-panel-heading">
          <div>
            <h2>Customer events</h2>
            <p>{customerEvents.length} isolated events · chronological</p>
          </div>
        </div>
        {customerEvents.map((event) => (
          <div className="event-with-actions" key={event.id}>
            <EventRow event={event} customer={customer} />
            {event.type !== "reversal" && !reversalTargets.has(event.id) && (
              <button
                className="text-action"
                onClick={() => setReversalCandidate(event)}
              >
                Reverse
              </button>
            )}
            {reversalTargets.has(event.id) && (
              <span className="reversed-label">Reversed</span>
            )}
          </div>
        ))}
        {!customerEvents.length && (
          <EmptyState
            title="No events yet"
            detail="Confirmed ledger events for this customer appear here."
          />
        )}
      </section>
      <section className="portal-panel separated-values">
        <h2>Other event totals</h2>
        <span>
          Refunds{" "}
          <b>
            {money(
              customerEvents
                .filter((item) => item.type === "refund")
                .reduce((sum, item) => sum + item.amount_paise, 0),
            )}
          </b>
        </span>
        <span>
          Payables{" "}
          <b>
            {money(
              customerEvents
                .filter((item) => item.type === "payable")
                .reduce((sum, item) => sum + item.amount_paise, 0),
            )}
          </b>
        </span>
      </section>
      {reversalCandidate && (
        <Modal title="Confirm reversal" onCancel={() => setReversalCandidate(null)}>
          <p className="modal-description">This adds an append-only reversal for {money(reversalCandidate.amount_paise)}. The original event remains visible.</p>
          <div className="modal-actions">
            <button className="button button-quiet" onClick={() => setReversalCandidate(null)}>Cancel</button>
            <button className="button button-danger" onClick={() => void reverse()}>Confirm reversal</button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title="Edit customer profile" onCancel={() => setEditing(false)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void repository.updateCustomer(customer.id, {
              display_name: String(form.get("display_name") ?? ""),
              phone: String(form.get("phone") ?? ""),
              aliases: String(form.get("aliases") ?? "").split(/[,;\n]/).map((alias) => alias.trim()).filter(Boolean),
              language: form.get("language") ? String(form.get("language")) as "en" | "hi" | "te" : undefined,
            }).then(async () => {
              await refresh();
              setEditing(false);
              notify("Customer profile updated.");
            }).catch((issue: unknown) => notify(issue instanceof Error ? issue.message : "Could not update customer.", "error"));
          }}>
            <label className="field-label" htmlFor="edit-customer-name">Display name</label>
            <input id="edit-customer-name" name="display_name" required maxLength={80} defaultValue={customer.display_name} />
            <label className="field-label" htmlFor="edit-customer-phone">Phone number <span>Optional</span></label>
            <input id="edit-customer-phone" name="phone" maxLength={24} inputMode="tel" defaultValue={customer.phone} />
            <label className="field-label" htmlFor="edit-customer-aliases">{getMessage(language, "alsoCalled")} <span>{getMessage(language, "optionalAliasesHelp")}</span></label>
            <input id="edit-customer-aliases" name="aliases" maxLength={500} defaultValue={(customer.aliases ?? []).filter((alias) => alias !== customer.display_name).join(", ")} />
            <label className="field-label" htmlFor="edit-customer-language">{getMessage(language, "customerLanguage")}</label>
            <select id="edit-customer-language" name="language" defaultValue={customer.language ?? ""}>
              <option value="">—</option>
              <option value="te">{getMessage(language, "speechTelugu")}</option>
              <option value="hi">{getMessage(language, "speechHindi")}</option>
              <option value="en">{getMessage(language, "speechEnglish")}</option>
            </select>
            <div className="modal-actions">
              <button type="button" className="button button-quiet" onClick={() => setEditing(false)}>Cancel</button>
              <button className="button button-primary">Save profile</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function LedgerPage() {
  const { customers, events, language } = useMerchant();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [customerId, setCustomerId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtered = events.filter((event) => {
    const name =
      customers.find((customer) => customer.id === event.customer_id)
        ?.display_name ?? "";
    const date = new Date(event.occurred_at).toISOString().slice(0, 10);
    return (
      `${name} ${event.note} ${event.transcript_raw}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (type === "all" || event.type === type) &&
      (customerId === "all" || event.customer_id === customerId) &&
      (!from || date >= from) &&
      (!to || date <= to)
    );
  });
  return (
    <>
      <Heading
        title={getMessage(language, "ledger")}
        note="Append-only event history. Corrections add a reversal event; original events remain."
        action={
          <button
            className="button button-outline"
            onClick={() => downloadCsv(eventsToCsv(filtered, customers))}
          >
            <Download size={16} /> Export CSV
          </button>
        }
      />
      <div className="portal-toolbar filter-toolbar">
        <label className="portal-search">
          <Search size={16} />
          <input
            aria-label="Search events"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer or note"
          />
        </label>
        <select
          aria-label="Filter event type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="all">All event types</option>
          {Object.entries(typeLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter customer"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        >
          <option value="all">All customers</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.display_name}
            </option>
          ))}
        </select>
        <input
          aria-label="From date"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <input
          aria-label="To date"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      <div className="event-summary">
        <span>{filtered.length} events</span>
        <span>
          Credit sales{" "}
          <b>
            {money(
              filtered
                .filter((event) => event.type === "credit_sale")
                .reduce((sum, event) => sum + event.amount_paise, 0),
            )}
          </b>
        </span>
        <span>
          Payments{" "}
          <b>
            {money(
              filtered
                .filter((event) => event.type === "payment_received")
                .reduce((sum, event) => sum + event.amount_paise, 0),
            )}
          </b>
        </span>
      </div>
      <div className="portal-list">
        {filtered.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            customer={customers.find((item) => item.id === event.customer_id)}
          />
        ))}
        {!filtered.length && (
          <EmptyState
            title="No events found"
            detail="Change filters or add a confirmed event through voice ledger."
          />
        )}
      </div>
    </>
  );
}
function DuesPage() {
  const { customers, events, language } = useMerchant();
  const debtors = customers
    .map((customer) => ({
      customer,
      balance: balanceOwedPaise(events, customer.id),
      last:
        events
          .filter((event) => event.customer_id === customer.id)
          .sort((a, b) => b.occurred_at - a.occurred_at)[0]?.occurred_at ?? 0,
    }))
    .filter((item) => item.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  return (
    <>
      <Heading
        title={getMessage(language, "dues")}
        note="Only confirmed credit sales less payments received. No reminders are sent automatically."
      />
      <div className="dues-highlight">
        <Wallet size={20} />
        <span>
          Total outstanding<small>{debtors.length} customers</small>
        </span>
        <b>{money(debtors.reduce((sum, item) => sum + item.balance, 0))}</b>
      </div>
      <div className="portal-list">
        {debtors.map(({ customer, balance, last }) => (
          <div className="due-list-row" key={customer.id}>
            <span className="customer-avatar">
              {customer.display_name.slice(0, 1)}
            </span>
            <div>
              <b>{customer.display_name}</b>
              <small>Last event {last ? dateShort(last) : "—"}</small>
            </div>
            <strong>{money(balance)}</strong>
            <button
              className="button button-outline"
              onClick={() => openWhatsApp(customer, balance, language)}
            >
              <Bell size={15} /> Remind
            </button>
          </div>
        ))}
        {!debtors.length && (
          <EmptyState
            title="No pending dues"
            detail="Customers with a positive balance appear here."
          />
        )}
      </div>
    </>
  );
}
function OrdersPage() {
  const { orders, customers, repository, refresh, notify } = useMerchant();
  const [adding, setAdding] = useState(false);
  const changeStatus = async (order: Order, status: Order["status"]) => {
    await repository.updateOrderStatus(order.id, status);
    await refresh();
    notify("Order updated. No payment event was created.");
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await repository.createOrder(
        String(form.get("customer_id")),
        String(form.get("description")),
      );
      await refresh();
      setAdding(false);
    } catch (issue) {
      notify(
        issue instanceof Error ? issue.message : "Could not create order.",
        "error",
      );
    }
  };
  return (
    <>
      <Heading
        title="Orders"
        note="Order completion never changes the financial event ledger."
        action={
          <button
            className="button button-primary"
            disabled={!customers.length}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} /> New order
          </button>
        }
      />
      <div className="portal-list">
        {orders.map((order) => (
          <div className="order-list-row" key={order.id}>
            <ShoppingBag size={18} />
            <div>
              <b>{order.description}</b>
              <small>
                {
                  customers.find(
                    (customer) => customer.id === order.customer_id,
                  )?.display_name
                }
              </small>
            </div>
            <select
              aria-label={`Order status ${order.description}`}
              value={order.status}
              onChange={(event) =>
                void changeStatus(order, event.target.value as Order["status"])
              }
            >
              {["New", "In Progress", "Ready", "Completed"].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </div>
        ))}
        {!orders.length && (
          <EmptyState
            title="No orders yet"
            detail="Orders can be tracked without affecting customer balances."
          />
        )}
      </div>
      {adding && (
        <Modal title="Create an order" onCancel={() => setAdding(false)}>
          <form onSubmit={(event) => void create(event)}>
            <label className="field-label" htmlFor="order-customer">
              Customer
            </label>
            <select id="order-customer" name="customer_id" required>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.display_name}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="order-description">
              Order description
            </label>
            <input
              id="order-description"
              name="description"
              required
              maxLength={240}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button className="button button-primary">Create order</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function ReportsPage() {
  const { events, orders } = useMerchant();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const dailyReport = aggregateDailyReport(events, date);
  const { paymentPaise: paid, creditPaise: credit, eventCount } = dailyReport;
  const statuses = ["New", "In Progress", "Ready", "Completed"] as const;
  const bars = Array.from({ length: 7 }, (_, index) => {
    const target = new Date();
    target.setDate(target.getDate() - (6 - index));
    const total = effectiveEvents(events)
      .filter(
        (event) =>
          event.type === "payment_received" &&
          new Date(event.occurred_at).toDateString() === target.toDateString(),
      )
      .reduce((sum, event) => sum + event.amount_paise, 0);
    return {
      label: target.toLocaleDateString("en-IN", { weekday: "short" }),
      total,
    };
  });
  const max = Math.max(...bars.map((bar) => bar.total), 1);
  return (
    <>
      <Heading
        title="Reports"
        note="Daily event totals and order counts; not bank or payment-gateway verification."
        action={
          <label className="report-date-control">
            Report date{" "}
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        }
      />
      <div className="portal-metrics">
        <Metric
          label="Payments received"
          value={money(paid)}
          note="payment_received events"
          tone="positive"
        />
        <Metric
          label="Credit sales"
          value={money(credit)}
          note="credit_sale events"
          tone="warning"
        />
        <Metric
          label="Current outstanding"
          value={money(balanceOwedPaise(events))}
          note="All merchant customers"
          tone="due"
        />
        <Metric
          label="Events this day"
          value={String(eventCount)}
          note="Including non-balance event types"
        />
      </div>
      <div className="portal-columns">
        <section className="portal-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Payments · last seven days</h2>
              <p>Event totals</p>
            </div>
          </div>
          <div className="report-bars">
            {bars.map((bar) => (
              <div key={bar.label}>
                <span
                  style={{ height: `${Math.max(4, (bar.total / max) * 100)}%` }}
                  title={money(bar.total)}
                />
                <small>{bar.label}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="portal-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Order counts</h2>
              <p>Independent of payments</p>
            </div>
          </div>
          {statuses.map((status) => (
            <div className="status-count" key={status}>
              {status}
              <b>{orders.filter((order) => order.status === status).length}</b>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
function MembershipPage() {
  const {
    merchantId,
    membership,
    customers,
    setMembership,
    repository,
    notify,
    language,
  } = useMerchant();
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [choice, setChoice] = useState<(typeof PLANS)[number] | null>(null);
  const [checkout, setCheckout] = useState<CheckoutSession | null>(null);
  const [outcome, setOutcome] = useState<
    "success" | "failure" | "pending" | null
  >(null);
  const [invoices, setInvoices] = useState<
    Awaited<ReturnType<typeof repository.listInvoices>>
  >([]);
  const current =
    PLANS.find((plan) => plan.key === membership.plan_key) ?? PLANS[0];
  const speechPercent = current.speech_minutes
    ? Math.min(100, (membership.speech_minutes_used / current.speech_minutes) * 100)
    : 0;
  useEffect(() => {
    void repository.listInvoices().then(setInvoices);
  }, [repository]);
  const begin = async (plan: (typeof PLANS)[number]) => {
    if (plan.key === "free") {
      await setMembership({ ...membership, plan_key: "free" });
      notify("Free plan selected.");
      return;
    }
    setCheckout(await mockPaymentService.createCheckout({ plan_key: plan.key, billing_period: period }));
    setChoice(plan);
    setOutcome(null);
  };
  const finishCheckout = async (status: "success" | "failure" | "pending") => {
    if (!choice || !checkout || outcome) return;
    await mockPaymentService.confirmPayment(checkout, status);
    setOutcome(status);
    const checkoutStatus =
      status === "success"
        ? "paid"
        : status === "failure"
          ? "failed"
          : "pending";
    const subtotal =
      period === "yearly" ? choice.yearly_paise : choice.monthly_paise;
    const invoice = createInvoice(merchantId, choice.key, subtotal, checkoutStatus);
    await repository.createInvoice(invoice);
    setInvoices(await repository.listInvoices());
    if (status === "success")
      await setMembership({ ...membership, plan_key: choice.key });
  };
  return (
    <>
      <Heading
        title="Membership"
        note="Choose a plan that fits your work. Demo checkout does not move real money."
      />
      <div className="demo-payment-banner">
        {getMessage(language, "demoPayments")}
      </div>
      <section className="portal-panel membership-usage">
        <div><b>Current usage · {current.name}</b><span>{membership.speech_minutes_used} / {current.speech_minutes} speech minutes</span><div className="usage-track"><i style={{ width: `${speechPercent}%` }} /></div></div>
        <div><b>Customers</b><span>{customers.length} / {current.customer_limit}</span><div className="usage-track"><i style={{ width: `${Math.min(100, customers.length / current.customer_limit * 100)}%` }} /></div></div>
      </section>
      <div className="billing-period-switch">
        <button
          className={period === "monthly" ? "selected" : ""}
          onClick={() => setPeriod("monthly")}
        >
          Monthly
        </button>
        <button
          className={period === "yearly" ? "selected" : ""}
          onClick={() => setPeriod("yearly")}
        >
          Yearly · save two months
        </button>
      </div>
      <div className="plan-grid">
        {PLANS.map((plan) => (
          <section
            className={`plan-card ${current.key === plan.key ? "current-plan" : ""}`}
            key={plan.key}
          >
            <span className="plan-name">
              {plan.name}
              {current.key === plan.key && <i>Current</i>}
            </span>
            <b className="plan-price">
              {money(
                period === "yearly" ? plan.yearly_paise : plan.monthly_paise,
              )}
              <small>/{period === "yearly" ? "year" : "month"}</small>
            </b>
            <span className="plan-usage">
              {plan.speech_minutes} speech min · {plan.customer_limit} customers
            </span>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>
                  <Check size={14} />
                  {feature}
                </li>
              ))}
            </ul>
            <button
              className="button button-outline"
              onClick={() => void begin(plan)}
            >
              {plan.key === current.key
                ? "Current plan"
                : plan.monthly_paise > current.monthly_paise
                  ? "Upgrade"
                  : "Change plan"}
            </button>
          </section>
        ))}
      </div>
      <section className="portal-panel invoice-panel">
        <div className="portal-panel-heading">
          <div>
            <h2>Billing history</h2>
            <p>Invoices include 18% GST, computed in paise.</p>
          </div>
          <button
            className="button button-outline"
            onClick={() => window.print()}
          >
            <Download size={15} /> Print / save PDF
          </button>
        </div>
        {invoices.map((invoice) => (
          <div className="invoice-row" key={invoice.id}>
            <b>{invoice.invoice_number}</b>
            <span>{invoice.plan_key.toUpperCase()}</span>
            <strong>{money(invoice.total_paise)}</strong>
            <span className={`status-${invoice.status}`}>{invoice.status}</span>
          </div>
        ))}
        {!invoices.length && (
          <EmptyState
            title="No invoices yet"
            detail="Completed or pending demo checkouts will appear here."
          />
        )}
      </section>
      <section className="portal-panel payment-method-panel">
        <CreditCardIcon />{" "}
        <div>
          <b>Payment method</b>
          <small>
            No card, CVV, UPI PIN or real payment details are collected in this
            demo.
          </small>
        </div>
        <span>Not configured</span>
      </section>
      {choice && (
        <Modal
          title={`Demo checkout · ${choice.name}`}
          onCancel={() => { setChoice(null); setCheckout(null); setOutcome(null); }}
        >
          <div className="demo-payment-banner">
            No real money moves. Select an outcome to exercise the checkout
            flow.
          </div>
          <p className="checkout-total">
            Amount before GST{" "}
            <b>
              {money(
                period === "yearly"
                  ? choice.yearly_paise
                  : choice.monthly_paise,
              )}
            </b>
          </p>
          <p className="checkout-total">
            GST · 18%{" "}
            <b>
              {money(
                Math.round(
                  ((period === "yearly"
                    ? choice.yearly_paise
                    : choice.monthly_paise) *
                    18) /
                    100,
                ),
              )}
            </b>
          </p>
          {outcome && (
            <p role="status" className="checkout-outcome">
              Mock payment {outcome}.{" "}
              {outcome === "success"
                ? "Membership changed."
                : "Membership was not changed."}
            </p>
          )}
          <div className="checkout-outcomes">
            <button
              className="button button-primary"
              disabled={outcome !== null}
              onClick={() => void finishCheckout("success")}
            >
              Success
            </button>
            <button
              className="button button-outline"
              disabled={outcome !== null}
              onClick={() => void finishCheckout("failure")}
            >
              Failure
            </button>
            <button
              className="button button-outline"
              disabled={outcome !== null}
              onClick={() => void finishCheckout("pending")}
            >
              Pending
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function SettingsPage() {
  const {
    merchantId,
    repository,
    language,
    setLanguage,
    speechEnabled,
    setSpeechEnabled,
    speechInputLanguage,
    setSpeechInputLanguage,
    cloudAssistConsent,
    setCloudAssistConsent,
    lastSyncAt,
    lastSyncError,
    queue,
    events,
    online,
    refresh,
    notify,
  } = useMerchant();
  const [resetOpen, setResetOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [voiceDebugEnabled, setVoiceDebugEnabled] = useState(false);
  const useServerSync = isSupabaseConfigured;
  const pending = queue.filter((item) => item.status === "pending").length;
  const rejected = events.filter(
    (event) => event.sync_status === "rejected",
  ).length;
  useEffect(() => {
    let active = true;
    void repository.getPreference("voice-debug-enabled").then((value) => {
      if (active) setVoiceDebugEnabled(value === "true");
    }).catch((issue: unknown) => notify(issue instanceof Error ? issue.message : "Could not load parser settings.", "error"));
    return () => { active = false; };
  }, [repository, notify]);
  const setVoiceDebug = async (enabled: boolean) => {
    try {
      await repository.setPreference("voice-debug-enabled", String(enabled));
      setVoiceDebugEnabled(enabled);
    } catch (issue) {
      notify(issue instanceof Error ? issue.message : "Could not save parser settings.", "error");
    }
  };
  const synced = events.filter(
    (event) => event.sync_status === "synced",
  ).length;
  const sync = async () => {
    setSyncing(true);
    try {
      const service = useServerSync ? supabaseSyncService : mockSyncService;
      const result = await service.sync(repository, online);
      const completedAt = Date.now();
      await repository.setPreference("last-sync-at", String(completedAt));
      await repository.setPreference("last-sync-error", "");
      await refresh();
      notify(
        online
          ? `${useServerSync ? "Supabase" : "Local demo"} sync complete: ${result.synced} processed, ${result.rejected} rejected, ${result.pending} pending.`
          : "Offline: local changes remain queued.",
        online ? "success" : "error",
      );
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "Sync failed.";
      await repository.setPreference("last-sync-error", message);
      await refresh();
      notify(message, "error");
    } finally {
      setSyncing(false);
    }
  };
  const reset = async () => {
    await repository.clearDemoData();
    await repository.seedDemoData();
    await refresh();
    setResetOpen(false);
    notify("Demo records restored. Merchant-entered records were preserved.");
  };
  return (
    <>
      <Heading
        title="Settings"
        note="Preferences and local synchronization status for this merchant."
      />
      <section className="portal-panel settings-list">
        <div className="settings-line">
          <Languages size={18} />
          <div>
            <b>Interface language</b>
            <small>Used for translated portal strings.</small>
          </div>
          <select
            aria-label="Interface language"
            value={language}
            onChange={(event) =>
              void setLanguage(event.target.value as UiLanguage)
            }
          >
            <option value="en">English</option>
            <option value="hi">हिन्दी</option>
            <option value="te">తెలుగు</option>
          </select>
        </div>
        <div className="settings-line">
          <ShieldCheck size={18} />
          <div>
            <b>Cloud speech and translation</b>
            <small>Off by default. Audio/transcript may be sent to a configured provider only when you choose cloud assistance.</small>
          </div>
          <button
            className={`toggle ${cloudAssistConsent ? "toggle-on" : ""}`}
            role="switch"
            aria-checked={cloudAssistConsent}
            aria-label="Cloud assist consent"
            onClick={() => void setCloudAssistConsent(!cloudAssistConsent)}
          >
            <span />
          </button>
        </div>
        <div className="settings-line">
          <Headphones size={18} />
          <div>
            <b>Spoken read-back</b>
            <small>Off by default. Uses browser speech synthesis.</small>
          </div>
          <button
            className={`toggle ${speechEnabled ? "toggle-on" : ""}`}
            role="switch"
            aria-checked={speechEnabled}
            aria-label="Spoken read-back"
            onClick={() => void setSpeechEnabled(!speechEnabled)}
          >
            <span />
          </button>
        </div>
        <div className="settings-line">
          <Mic size={18} />
          <div>
            <b>Speech input language</b>
            <small>Recognition service may require internet.</small>
          </div>
          <select
            aria-label="Speech input language"
            value={speechInputLanguage}
            onChange={(event) =>
              void setSpeechInputLanguage(event.target.value as LanguageCode)
            }
          >
            <option value="en">English · en-IN</option>
            <option value="hi">Hindi · hi-IN</option>
            <option value="te">Telugu · te-IN</option>
          </select>
        </div>
        {import.meta.env.DEV && (
          <div className="settings-line">
            <Settings size={18} />
            <div>
              <b>{getMessage(language, "parserDebug")}</b>
              <small>{getMessage(language, "parserDebugSetting")}</small>
            </div>
            <button
              className={`toggle ${voiceDebugEnabled ? "toggle-on" : ""}`}
              role="switch"
              aria-checked={voiceDebugEnabled}
              aria-label={getMessage(language, "parserDebugSetting")}
              onClick={() => void setVoiceDebug(!voiceDebugEnabled)}
            >
              <span />
            </button>
          </div>
        )}
        <div className="settings-line">
          <Wifi size={18} />
          <div>
            <b>Local sync status</b>
            <small>
              {queue.length} queue items · {pending} pending · {synced} synced ·{" "}
              {rejected} rejected
              {lastSyncAt ? ` · Last attempt ${new Date(lastSyncAt).toLocaleString()}` : " · Never synced"}
            </small>
          </div>
          {lastSyncError && <p className="form-error" role="alert">{lastSyncError}</p>}
          <span
            className={`status-pill ${online ? "status-ok" : "status-due"}`}
          >
            {online ? "Online" : "Offline"}
          </span>
        </div>
        <div className="settings-line">
          <ShieldCheck size={18} />
          <div>
            <b>Merchant data scope</b>
            <small>{merchantId} · IndexedDB local database</small>
          </div>
          <span className="status-pill status-ok">Isolated</span>
        </div>
        <div className="settings-line">
          <Activity size={18} />
          <div>
            <b>{useServerSync ? "Supabase sync" : "Local demo sync"}</b>
            <small>{useServerSync
              ? "Direct authenticated Supabase sync with RLS and a server timestamp cursor."
              : "Supabase is not configured; records stay in this browser’s local database."}</small>
          </div>
          <button
            className="button button-outline"
            disabled={syncing || (!pending && !useServerSync)}
            onClick={() => void sync()}
          >
            {syncing ? "Syncing…" : "Sync pending records"}
          </button>
        </div>
      </section>
      <section className="portal-panel reset-panel">
        <div>
          <b>Reset demo data</b>
          <small>
            Removes demo customers/events only. Merchant-entered records stay.
          </small>
        </div>
        <button
          className="button button-danger"
          onClick={() => setResetOpen(true)}
        >
          Reset demo data
        </button>
      </section>
      {resetOpen && (
        <Modal title="Reset demo records?" onCancel={() => setResetOpen(false)}>
          <p className="modal-description">
            {getMessage(language, "resetWarning")} This cannot be undone.
          </p>
          <div className="modal-actions">
            <button
              className="button button-quiet"
              onClick={() => setResetOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button-danger"
              onClick={() => void reset()}
            >
              Confirm reset
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function MerchantNotFound() {
  return (
    <EmptyState
      title="Not found"
      detail="This merchant page could not be found."
    />
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="portal-empty">
      <CircleHelp size={24} />
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}
function Modal({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-heading">
          <h2 id="modal-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function openWhatsApp(
  customer: Customer,
  balance: number,
  language: UiLanguage,
) {
  const url = buildWhatsAppReminderUrl(customer.phone, customer.display_name, balance, language);
  if (!url) {
    window.alert("Add a valid phone number before sharing this reminder.");
    return;
  }
  window.open(
    url,
    "_blank",
    "noopener,noreferrer",
  );
}
function downloadCsv(csv: string) {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lokmitra-events-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
function CreditCardIcon() {
  return <span className="payment-icon">INR</span>;
}
