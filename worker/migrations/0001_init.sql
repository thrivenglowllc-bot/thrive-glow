-- Applied at deploy time by `wrangler d1 migrations apply DB --remote` (wrangler tracks versions in d1_migrations).
-- Never edit an applied migration; add 0002_*.sql instead.

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT, email TEXT NOT NULL, phone TEXT,
  interest TEXT, goal TEXT, heard TEXT,
  emailed INTEGER DEFAULT 0,          -- 1 = owner emailed, 2 = client emailed, 3 = both
  status TEXT DEFAULT 'new'           -- new, booked, client, not_a_fit
);

CREATE TABLE IF NOT EXISTS orders (
  ref TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,               -- checkout_started, paid, refunded, failed
  program_key TEXT, program_name TEXT,
  amount_cents INTEGER NOT NULL,
  email TEXT, name TEXT,
  session_id TEXT,                    -- Stripe Checkout session
  payment_intent TEXT,
  subscription_id TEXT,               -- set for monthly payment plans
  plan_payments INTEGER DEFAULT 1,    -- 1 = paid in full
  paid_at TEXT, paid_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0,
  notified_paid_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS orders_payment_intent ON orders(payment_intent);

CREATE INDEX IF NOT EXISTS orders_subscription ON orders(subscription_id);

-- One row per paid monthly installment (Stripe invoice), so retries never double-count.
CREATE TABLE IF NOT EXISTS installments (
  invoice_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER DEFAULT 0,
  refunded_cents INTEGER DEFAULT 0,
  payment_intent TEXT,
  paid_at TEXT NOT NULL
);
