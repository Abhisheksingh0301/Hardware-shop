// ---------------------------------------------------------------------------
// db.js
// Opens the SQLite database (hwshop.db), creates the tables, and exports
// small async helpers: run(), get(), all(), transaction().
// Also holds the fixed lists (units, categories, statuses) used by the forms.
// ---------------------------------------------------------------------------

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbFile = process.env.DB_FILE || path.join(__dirname, 'hwshop.db');
const db = new sqlite3.Database(dbFile);

db.run('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------------------
// Promise wrappers around the callback-style sqlite3 API
// ---------------------------------------------------------------------------

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    // A normal function (not an arrow) so "this" holds lastID / changes.
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// "All of it or none of it". Transactions are queued one after another
// because there is only one connection, so two could otherwise interleave.
let queue = Promise.resolve();

function transaction(work) {
  const result = queue.then(async () => {
    await run('BEGIN');
    try {
      const value = await work();
      await run('COMMIT');
      return value;
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  });
  queue = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

// Lets route handlers be async: errors go to Express's error handler.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Form text -> number (0 when empty or invalid).
function num(value) {
  const n = parseFloat(value);
  return isNaN(n) ? 0 : n;
}

// Form value that may be a single string or an array -> always an array.
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const round2 = (n) => Math.round(n * 100) / 100;

// Changes a product's stock and writes a line in the inventory register.
async function moveStock(productId, qty, kind, refId, note) {
  await run('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, productId]);
  await run(
    'INSERT INTO stock_moves (product_id, qty, kind, ref_id, note) VALUES (?, ?, ?, ?, ?)',
    [productId, qty, kind, refId || null, note || null]
  );
}

// Next document number like INV-2026-0001 or GRILL-2026-001.
async function nextNumber(table, column, prefix, width) {
  const year = new Date().getFullYear();
  const start = `${prefix}-${year}-`;
  const row = await get(
    `SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`,
    [start + '%']
  );
  const last = row ? parseInt(row.no.slice(start.length), 10) || 0 : 0;
  return start + String(last + 1).padStart(width, '0');
}

// SQL for the outstanding balance: what customer "c" owes us / what we owe
// supplier "s". Used inside SELECTs that alias the table as c or s.
const CUSTOMER_DUE = `(c.opening_balance
  + COALESCE((SELECT SUM(total) FROM invoices WHERE customer_id = c.id), 0)
  + COALESCE((SELECT SUM(agreed_price) FROM grill_jobs WHERE customer_id = c.id AND status <> 'Cancelled'), 0)
  - COALESCE((SELECT SUM(amount) FROM payments WHERE direction = 'in' AND customer_id = c.id), 0))`;

const SUPPLIER_DUE = `(s.opening_balance
  + COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id = s.id), 0)
  - COALESCE((SELECT SUM(amount) FROM payments WHERE direction = 'out' AND supplier_id = s.id), 0))`;

// ---------------------------------------------------------------------------
// Fixed lists shown in the forms
// ---------------------------------------------------------------------------

const PRODUCT_TYPES = { paint: 'Paint', hardware: 'Hardware', raw: 'Raw Material' };

const CATEGORIES = {
  paint: [
    'Interior Wall Paint', 'Exterior Wall Paint', 'Primer', 'Wall Putty', 'Enamel Paint',
    'Metal Paint', 'Wood Paint', 'Thinner', 'Waterproofing', 'Brushes', 'Rollers', 'Accessories'
  ],
  hardware: [
    'Screws', 'Nuts & Bolts', 'Nails', 'Hinges', 'Door Handles', 'Locks', 'Latches',
    'Tower Bolts', 'Brackets', 'Fasteners', 'Hand Tools', 'Power-tool Accessories',
    'Cutting Discs', 'Welding Electrodes', 'Pipes & Fittings', 'Metal Sections',
    'Construction Accessories', 'Other'
  ],
  raw: [
    'MS Rod', 'MS Flat', 'MS Angle', 'MS Pipe', 'MS Sheet', 'Welding Electrode',
    'Cutting Disc', 'Grinding Disc', 'Primer', 'Paint', 'Consumables'
  ]
};

const UNITS = ['Piece', 'Box', 'Packet', 'Dozen', 'Kg', 'Litre', 'Meter', 'Feet', 'Bucket', 'Can'];

const GRILL_STATUSES = [
  'New', 'Measurement Completed', 'Material Available', 'In Production', 'Welding Completed',
  'Grinding Completed', 'Painting Completed', 'Ready for Delivery', 'Delivered', 'Installed',
  'Completed', 'Cancelled'
];

const GRILL_TYPES = ['Window Grill', 'Door Grill', 'Balcony Grill', 'Gate', 'Staircase Railing', 'Other'];

const PAY_MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];

const EXPENSE_CATEGORIES = [
  'Rent', 'Electricity', 'Salary / Wages', 'Transport', 'Tea & Refreshments',
  'Repairs', 'Stationery', 'Other'
];

// ---------------------------------------------------------------------------
// Schema - "IF NOT EXISTS" makes this safe to run on every start
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  phone           TEXT,
  address         TEXT,
  gstin           TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,   -- amount customer already owed us
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  contact_person    TEXT,
  phone             TEXT,
  address           TEXT,
  gstin             TEXT,
  products_supplied TEXT,
  credit_days       INTEGER NOT NULL DEFAULT 0,
  opening_balance   REAL NOT NULL DEFAULT 0,  -- amount we already owed them
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS brands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  supplier_id     INTEGER REFERENCES suppliers(id),  -- distributor
  dealer_discount REAL NOT NULL DEFAULT 0,           -- %
  credit_terms    TEXT,
  payment_terms   TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK (type IN ('paint','hardware','raw')),
  name           TEXT NOT NULL,
  category       TEXT,
  brand_id       INTEGER REFERENCES brands(id),
  size           TEXT,
  unit           TEXT NOT NULL DEFAULT 'Piece',
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price  REAL NOT NULL DEFAULT 0,
  gst_rate       REAL NOT NULL DEFAULT 18,
  stock          REAL NOT NULL DEFAULT 0,
  min_stock      REAL NOT NULL DEFAULT 0,
  supplier_id    INTEGER REFERENCES suppliers(id),
  active         INTEGER NOT NULL DEFAULT 1
);

-- Inventory register: every stock change, + in / - out
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL,
  kind       TEXT NOT NULL,          -- purchase | sale | grill | adjust
  ref_id     INTEGER,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no    TEXT,                -- supplier's bill number
  purchase_date TEXT NOT NULL,
  subtotal      REAL NOT NULL,
  tax           REAL NOT NULL,
  total         REAL NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL,
  rate        REAL NOT NULL,
  gst_rate    REAL NOT NULL,
  amount      REAL NOT NULL          -- incl. tax
);

CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no    TEXT NOT NULL UNIQUE,
  customer_id   INTEGER REFERENCES customers(id),   -- NULL = walk-in
  customer_name TEXT,
  invoice_date  TEXT NOT NULL,
  subtotal      REAL NOT NULL,
  discount      REAL NOT NULL,
  tax           REAL NOT NULL,
  total         REAL NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL,
  rate       REAL NOT NULL,
  cost       REAL NOT NULL,          -- purchase price at time of sale, for profit
  disc_pct   REAL NOT NULL DEFAULT 0,
  gst_rate   REAL NOT NULL,
  amount     REAL NOT NULL           -- incl. discount and tax
);

CREATE TABLE IF NOT EXISTS grill_jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no                TEXT NOT NULL UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  site_address          TEXT,
  grill_type            TEXT,
  width                 TEXT,
  height                TEXT,
  quantity              INTEGER NOT NULL DEFAULT 1,
  frame_size            TEXT,
  rod_size              TEXT,
  spacing               TEXT,
  other_measurements    TEXT,
  design                TEXT,
  material_spec         TEXT,
  finish                TEXT,
  delivery_required     INTEGER NOT NULL DEFAULT 1,
  installation_required INTEGER NOT NULL DEFAULT 0,
  agreed_price          REAL NOT NULL DEFAULT 0,
  expected_date         TEXT,
  status                TEXT NOT NULL DEFAULT 'New',
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS grill_materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES grill_jobs(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  est_qty    REAL NOT NULL DEFAULT 0,
  issued_qty REAL NOT NULL DEFAULT 0,
  UNIQUE (job_id, product_id)
);

CREATE TABLE IF NOT EXISTS grill_status_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES grill_jobs(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Money in (from customers) and money out (to suppliers)
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_date    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  customer_id INTEGER REFERENCES customers(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  invoice_id  INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  job_id      INTEGER REFERENCES grill_jobs(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  mode        TEXT NOT NULL,
  reference   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount   REAL NOT NULL,
  mode     TEXT NOT NULL,
  note     TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_type  ON products(type);
CREATE INDEX IF NOT EXISTS idx_moves_product  ON stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date  ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_payments_date  ON payments(pay_date);
CREATE INDEX IF NOT EXISTS idx_expenses_date  ON expenses(exp_date);
`;

const ready = new Promise((resolve, reject) => {
  db.exec(SCHEMA, (err) => (err ? reject(err) : resolve()));
});

module.exports = {
  db, run, get, all, transaction, ready,
  wrap, num, list, round2, moveStock, nextNumber, CUSTOMER_DUE, SUPPLIER_DUE,
  PRODUCT_TYPES, CATEGORIES, UNITS, GRILL_STATUSES, GRILL_TYPES, PAY_MODES, EXPENSE_CATEGORIES
};
