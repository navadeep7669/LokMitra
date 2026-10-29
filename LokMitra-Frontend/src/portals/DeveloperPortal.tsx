import { useState, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Boxes,
  CircleHelp,
  FileText,
  LayoutDashboard,
  LogOut,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useAuth } from "../auth/Auth";
import {
  paiseToRupees,
  type Invoice,
  type Subscription,
} from "../domain/events";

const sampleSubscriptions: Subscription[] = [
  {
    merchant_id: "m-demo-a",
    merchant_name: "Lakshmi Handlooms",
    plan_key: "pro",
    status: "active",
    renewal_date: "2026-11-18",
    monthly_paise: 19900,
  },
  {
    merchant_id: "m-demo-b",
    merchant_name: "Ravi Repairs",
    plan_key: "business",
    status: "active",
    renewal_date: "2026-11-21",
    monthly_paise: 49900,
  },
  {
    merchant_id: "m-demo-c",
    merchant_name: "Sita Home Kitchen",
    plan_key: "free",
    status: "active",
    renewal_date: "2026-11-24",
    monthly_paise: 0,
  },
  {
    merchant_id: "m-demo-d",
    merchant_name: "Meena Cakes",
    plan_key: "pro",
    status: "past_due",
    renewal_date: "2026-10-25",
    monthly_paise: 19900,
  },
  {
    merchant_id: "m-demo-e",
    merchant_name: "Arjun Mobile Care",
    plan_key: "business",
    status: "cancelled",
    renewal_date: "2026-10-12",
    monthly_paise: 49900,
  },
];
const sampleInvoices: Invoice[] = sampleSubscriptions
  .slice(0, 4)
  .map((subscription, index) => {
    const subtotal_paise = subscription.monthly_paise;
    const gst_paise = Math.round((subtotal_paise * 18) / 100);
    return {
      id: `inv-${index + 1}`,
      merchant_id: subscription.merchant_id,
      invoice_number: `LM-2026-${String(940 + index)}`,
      plan_key: subscription.plan_key,
      subtotal_paise,
      gst_paise,
      total_paise: subtotal_paise + gst_paise,
      status: index === 3 ? "pending" : "paid",
      created_at: Date.now() - index * 86_400_000,
    };
  });
const devNav = [
  ["/dev/overview", "Overview", LayoutDashboard],
  ["/dev/subscriptions", "Subscriptions", Users],
  ["/dev/invoices", "Invoices", FileText],
  ["/dev/sync-inspector", "Sync inspector", Boxes],
] as const;
export function DeveloperPortal() {
  const { session, logout } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  return (
    <DeveloperFrame logout={() => void logout()}>
      <Routes>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<DevOverview />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="sync-inspector" element={<SyncInspector />} />
        <Route
          path="*"
          element={
            <DevEmpty
              title="Not found"
              description="This developer page does not exist."
            />
          }
        />
      </Routes>
    </DeveloperFrame>
  );
}
function DeveloperFrame({
  children,
  logout,
}: {
  children: ReactNode;
  logout: () => void;
}) {
  return (
    <div className="portal-shell developer-shell">
      <aside className="portal-sidebar developer-sidebar">
        <Link to="/dev/overview" className="brand">
          <span className="brand-symbol">
            <span />
          </span>
          <span>
            <b>lokmitra</b>
            <small>DEVELOPER PORTAL</small>
          </span>
        </Link>
        <div className="workspace-label">
          MOCK OPERATIONS <span className="demo-chip">DEMO</span>
        </div>
        <nav aria-label="Developer navigation">
          {devNav.map(([path, label, Icon]) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `portal-nav-link ${isActive ? "active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="portal-sidebar-bottom">
          <Link className="portal-nav-link" to="/app/dashboard">
            <ArrowLeft size={17} />
            Merchant portal
          </Link>
          <button className="portal-nav-link logout-button" onClick={logout}>
            <LogOut size={18} />
            Log out
          </button>
        </div>
      </aside>
      <header className="portal-topbar">
        <span className="portal-workspace">
          LokMitra <i>/</i> Developer portal
        </span>
        <span className="topbar-demo">MOCK AGGREGATES ONLY</span>
        <button className="developer-logout-top" onClick={logout}>Log out</button>
      </header>
      <main className="portal-content developer-content">{children}</main>
      <nav className="developer-bottom-nav" aria-label="Developer mobile navigation">
        {devNav.map(([path, label, Icon]) => (
          <NavLink key={path} to={path} aria-label={label} className={({ isActive }) => isActive ? "active" : ""}>
            <Icon size={17} />
            <small>{label}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
function DevHeading({
  title,
  note,
  action,
}: {
  title: string;
  note: string;
  action?: ReactNode;
}) {
  return (
    <div className="portal-heading">
      <div>
        <h1>{title}</h1>
        <p>{note}</p>
      </div>
      {action}
    </div>
  );
}
function DevOverview() {
  return (
    <>
      <DevHeading
        title="Developer overview"
        note="Synthetic operational metrics only. No merchant ledger records are loaded in this portal."
      />
      <div className="developer-banner">
        <ShieldCheck size={18} /> Mock environment · API status: not connected
      </div>
      <div className="portal-metrics">
        <DevMetric
          label="API status"
          value="Mock"
          note="Backend contract pending"
        />
        <DevMetric
          label="Requests today"
          value="1,284"
          note="Generated sample data"
        />
        <DevMetric label="Error rate" value="0.8%" note="Synthetic aggregate" />
        <DevMetric label="Speech proxy" value="42 min" note="Sample usage" />
      </div>
      <div className="portal-columns">
        <section className="portal-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Sync queue health</h2>
              <p>Mock records only</p>
            </div>
            <Link to="/dev/sync-inspector">Inspect queue</Link>
          </div>
          <div className="sync-health-grid">
            <span>
              <b>12</b>pending
            </span>
            <span>
              <b>1</b>rejected
            </span>
            <span>
              <b>98.2%</b>healthy
            </span>
          </div>
        </section>
        <section className="portal-panel">
          <div className="portal-panel-heading">
            <div>
              <h2>Requests · 7 days</h2>
              <p>Illustrative API volume</p>
            </div>
          </div>
          <div className="report-bars">
            {[44, 71, 58, 88, 52, 94, 65].map((value, index) => (
              <div key={index}>
                <span style={{ height: `${value}%` }} />
                <small>{["M", "T", "W", "T", "F", "S", "S"][index]}</small>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
function DevMetric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <section className="portal-metric">
      <span className="metric-glyph mint">
        <Activity size={17} />
      </span>
      <small>{label}</small>
      <b>{value}</b>
      <span>{note}</span>
    </section>
  );
}
function SubscriptionsPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const rows = sampleSubscriptions.filter(
    (item) =>
      item.merchant_name.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || item.status === status),
  );
  const mrr = sampleSubscriptions
    .filter((item) => item.status === "active")
    .reduce((sum, item) => sum + item.monthly_paise, 0);
  return (
    <>
      <DevHeading
        title="Subscriptions"
        note={`Mock merchants · active MRR ${paiseToRupees(mrr)}`}
      />
      <div className="portal-toolbar">
        <label className="portal-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mock merchants"
            aria-label="Search subscriptions"
          />
        </label>
        <select
          aria-label="Filter subscription status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="past_due">Past due</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div className="portal-list">
        {rows.map((item) => (
          <div className="developer-table-row" key={item.merchant_id}>
            <b>{item.merchant_name}</b>
            <span>{item.plan_key}</span>
            <span className={`status-${item.status}`}>{item.status}</span>
            <span>Renews {item.renewal_date}</span>
            <strong>{paiseToRupees(item.monthly_paise)} / month</strong>
          </div>
        ))}
        {!rows.length && (
          <DevEmpty
            title="No subscriptions match"
            description="Change the search or status filter."
          />
        )}
      </div>
    </>
  );
}
function InvoicesPage() {
  return (
    <>
      <DevHeading
        title="Invoices"
        note="Synthetic billing records. Select an invoice to view and print details."
      />
      <div className="portal-list">
        {sampleInvoices.map((invoice) => (
          <Link
            className="developer-table-row invoice-link-row"
            to={`/dev/invoices/${invoice.id}`}
            key={invoice.id}
          >
            <b>{invoice.invoice_number}</b>
            <span>
              {
                sampleSubscriptions.find(
                  (item) => item.merchant_id === invoice.merchant_id,
                )?.merchant_name
              }
            </span>
            <strong>{paiseToRupees(invoice.total_paise)}</strong>
            <span>GST {paiseToRupees(invoice.gst_paise)}</span>
            <span className={`status-${invoice.status}`}>{invoice.status}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
function InvoiceDetail() {
  const { id = "" } = useParams();
  const invoice = sampleInvoices.find((item) => item.id === id);
  const merchant = sampleSubscriptions.find(
    (item) => item.merchant_id === invoice?.merchant_id,
  );
  if (!invoice)
    return (
      <DevEmpty
        title="Invoice not found"
        description="No mock invoice matches this address."
      />
    );
  return (
    <div className="print-invoice">
      <Link to="/dev/invoices" className="back-to-list">
        <ArrowLeft size={15} /> Invoices
      </Link>
      <div className="invoice-print-head">
        <div>
          <span className="eyebrow">LOKMITRA · MOCK BILLING</span>
          <h1>{invoice.invoice_number}</h1>
        </div>
        <button
          className="button button-outline"
          onClick={() => window.print()}
        >
          Print / Save PDF
        </button>
      </div>
      <p>
        Bill to: <b>{merchant?.merchant_name}</b>
      </p>
      <p>Plan: {invoice.plan_key.toUpperCase()}</p>
      <div className="invoice-math">
        <span>Subtotal</span>
        <b>{paiseToRupees(invoice.subtotal_paise)}</b>
        <span>GST · 18%</span>
        <b>{paiseToRupees(invoice.gst_paise)}</b>
        <strong>Total</strong>
        <strong>{paiseToRupees(invoice.total_paise)}</strong>
      </div>
      <span className={`status-${invoice.status}`}>{invoice.status}</span>
      <p className="demo-payment-banner">Demo invoice. No real money moved.</p>
    </div>
  );
}
function SyncInspector() {
  const [rows, setRows] = useState([
    { id: "q-101", type: "customer", status: "pending", reason: "" },
    { id: "q-102", type: "credit_sale", status: "pending", reason: "" },
    {
      id: "q-103",
      type: "payment_received",
      status: "rejected",
      reason: "CUSTOMER_NOT_FOUND",
    },
  ]);
  const retry = (id: string) =>
    setRows((current) =>
      current.map((row) =>
        row.id === id ? { ...row, status: "pending", reason: "" } : row,
      ),
    );
  return (
    <>
      <DevHeading
        title="Sync inspector"
        note="Synthetic queue entries for interface testing. No merchant records are present."
      />
      <div className="developer-banner">
        This inspector uses mock rows; merchant sync queues are visible only in
        that merchant’s settings.
      </div>
      <div className="portal-list">
        {rows.map((row) => (
          <div className="developer-table-row" key={row.id}>
            <b>{row.id}</b>
            <span>{row.type}</span>
            <span className={`status-${row.status}`}>{row.status}</span>
            <code>{row.reason || "—"}</code>
            {row.status === "rejected" && (
              <button
                className="button button-outline"
                onClick={() => retry(row.id)}
              >
                Retry mock
              </button>
            )}
          </div>
        ))}
        {!rows.length && (
          <DevEmpty title="Queue empty" description="No mock queue records." />
        )}
      </div>
    </>
  );
}
function DevEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="portal-empty">
      <CircleHelp size={24} />
      <b>{title}</b>
      <span>{description}</span>
    </div>
  );
}
