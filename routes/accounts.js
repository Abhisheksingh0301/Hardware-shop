// ---------------------------------------------------------------------------
// routes/accounts.js - customer / supplier payments, expenses,
// daily cash-UPI register, profit & loss and outstanding reports.
// ---------------------------------------------------------------------------

var express = require('express');
var { run, get, all, wrap, num, PAY_MODES, EXPENSE_CATEGORIES, CUSTOMER_DUE, SUPPLIER_DUE } = require('../db');

var router = express.Router();

function monthStart(req) {
  return req.app.locals.today().slice(0, 8) + '01';
}

// Only allow redirecting back to a page inside this app
function safeBack(url, fallback) {
  return typeof url === 'string' && /^\/[a-z]/i.test(url) ? url.split('?')[0] : fallback;
}

function withMsg(url, key, text) {
  return url + '?' + key + '=' + encodeURIComponent(text);
}

// ===========================================================================
// Payments
// ===========================================================================

router.get('/payments', wrap(async function (req, res) {
  var from = req.query.from || monthStart(req);
  var to = req.query.to || req.app.locals.today();
  var dir = req.query.dir === 'in' || req.query.dir === 'out' ? req.query.dir : '';
  var rows = await all(
    `SELECT p.*, c.name AS customer, s.name AS supplier, i.invoice_no, g.job_no, pu.invoice_no AS purchase_no
       FROM payments p
       LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN grill_jobs g ON g.id = p.job_id
       LEFT JOIN purchases pu ON pu.id = p.purchase_id
      WHERE p.pay_date BETWEEN ? AND ? ${dir ? 'AND p.direction = ?' : ''}
      ORDER BY p.pay_date DESC, p.id DESC`, dir ? [from, to, dir] : [from, to]);
  res.render('payments', {
    title: 'Payments', rows, from, to, dir, PAY_MODES,
    customers: await all(`SELECT c.id, c.name, ${CUSTOMER_DUE} AS due FROM customers c ORDER BY c.name`),
    suppliers: await all(`SELECT s.id, s.name, ${SUPPLIER_DUE} AS due FROM suppliers s ORDER BY s.name`)
  });
}));

// Records a payment. It may be "on account" (just a customer / supplier)
// or against a specific invoice, grill job or purchase.
router.post('/payments', wrap(async function (req, res) {
  var b = req.body;
  var backTo = safeBack(b.back, '/accounts/payments');
  var p = {
    pay_date: b.pay_date || req.app.locals.today(),
    direction: b.direction === 'out' ? 'out' : 'in',
    customer_id: parseInt(b.customer_id, 10) || null,
    supplier_id: parseInt(b.supplier_id, 10) || null,
    invoice_id: parseInt(b.invoice_id, 10) || null,
    job_id: parseInt(b.job_id, 10) || null,
    purchase_id: parseInt(b.purchase_id, 10) || null,
    amount: num(b.amount),
    mode: PAY_MODES.indexOf(b.mode) >= 0 ? b.mode : 'Cash',
    reference: (b.reference || '').trim(),
    note: (b.note || '').trim()
  };
  if (p.amount <= 0) return res.redirect(withMsg(backTo, 'err', 'Enter an amount above zero.'));

  // Link to the document and check the amount is not more than its balance
  var doc = null;
  if (p.invoice_id) {
    doc = await get(`SELECT customer_id, total - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS balance,
                            'Invoice ' || invoice_no AS label FROM invoices i WHERE id = ?`, [p.invoice_id]);
    if (doc) { p.direction = 'in'; p.customer_id = doc.customer_id; }
  } else if (p.job_id) {
    doc = await get(`SELECT customer_id, agreed_price - COALESCE((SELECT SUM(amount) FROM payments WHERE job_id = g.id), 0) AS balance,
                            'Job ' || job_no AS label FROM grill_jobs g WHERE id = ?`, [p.job_id]);
    if (doc) { p.direction = 'in'; p.customer_id = doc.customer_id; }
  } else if (p.purchase_id) {
    doc = await get(`SELECT supplier_id, total - COALESCE((SELECT SUM(amount) FROM payments WHERE purchase_id = pu.id), 0) AS balance,
                            'Purchase ' || COALESCE(invoice_no, id) AS label FROM purchases pu WHERE id = ?`, [p.purchase_id]);
    if (doc) { p.direction = 'out'; p.supplier_id = doc.supplier_id; }
  }
  if ((p.invoice_id || p.job_id || p.purchase_id) && !doc) return res.redirect(withMsg(backTo, 'err', 'Document not found.'));
  if (doc && p.amount > doc.balance + 0.001) {
    return res.redirect(withMsg(backTo, 'err', 'Amount is more than the balance due (' + req.app.locals.money(doc.balance) + ').'));
  }
  if (p.direction === 'in') p.supplier_id = null; else p.customer_id = null;
  if (!doc && p.direction === 'in' && !p.customer_id) return res.redirect(withMsg(backTo, 'err', 'Choose a customer.'));
  if (!doc && p.direction === 'out' && !p.supplier_id) return res.redirect(withMsg(backTo, 'err', 'Choose a supplier.'));
  if (!p.note && doc) p.note = 'Against ' + doc.label;

  var cols = Object.keys(p);
  await run(`INSERT INTO payments (${cols.join(', ')}) VALUES (${cols.map(function () { return '?'; }).join(', ')})`,
    cols.map(function (c) { return p[c]; }));
  res.redirect(withMsg(backTo, 'msg', 'Payment of ' + req.app.locals.money(p.amount) + ' recorded.'));
}));

router.post('/payments/:id/delete', wrap(async function (req, res) {
  await run('DELETE FROM payments WHERE id = ?', [req.params.id]);
  res.redirect(withMsg(safeBack(req.body.back, '/accounts/payments'), 'msg', 'Payment deleted.'));
}));

// Printable payment receipt / voucher
router.get('/payments/:id', wrap(async function (req, res) {
  var pay = await get(
    `SELECT p.*, c.name AS customer, c.phone AS c_phone, s.name AS supplier, s.phone AS s_phone,
            i.invoice_no, g.job_no, pu.invoice_no AS purchase_no
       FROM payments p
       LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN grill_jobs g ON g.id = p.job_id
       LEFT JOIN purchases pu ON pu.id = p.purchase_id WHERE p.id = ?`, [req.params.id]);
  if (!pay) return res.redirect('/accounts/payments');
  res.render('receipt', { title: pay.direction === 'in' ? 'Payment Receipt' : 'Payment Voucher', pay });
}));

// ===========================================================================
// Expenses
// ===========================================================================

router.get('/expenses', wrap(async function (req, res) {
  var from = req.query.from || monthStart(req);
  var to = req.query.to || req.app.locals.today();
  var rows = await all('SELECT * FROM expenses WHERE exp_date BETWEEN ? AND ? ORDER BY exp_date DESC, id DESC', [from, to]);
  var total = rows.reduce(function (s, r) { return s + r.amount; }, 0);
  res.render('expenses', { title: 'Expenses', rows, from, to, total, PAY_MODES, EXPENSE_CATEGORIES });
}));

router.post('/expenses', wrap(async function (req, res) {
  var b = req.body;
  var amount = num(b.amount);
  if (amount <= 0) return res.redirect(withMsg('/accounts/expenses', 'err', 'Enter an amount above zero.'));
  await run('INSERT INTO expenses (exp_date, category, amount, mode, note) VALUES (?, ?, ?, ?, ?)', [
    b.exp_date || req.app.locals.today(), (b.category || 'Other').trim(), amount,
    PAY_MODES.indexOf(b.mode) >= 0 ? b.mode : 'Cash', (b.note || '').trim()]);
  res.redirect(withMsg('/accounts/expenses', 'msg', 'Expense saved.'));
}));

router.post('/expenses/:id/delete', wrap(async function (req, res) {
  await run('DELETE FROM expenses WHERE id = ?', [req.params.id]);
  res.redirect(withMsg('/accounts/expenses', 'msg', 'Expense deleted.'));
}));

// ===========================================================================
// Daily Cash / UPI register
// ===========================================================================

router.get('/daybook', wrap(async function (req, res) {
  var date = req.query.date || req.app.locals.today();
  var rows = await all(
    `SELECT p.id, 'in' AS dir, p.mode, p.amount, p.reference,
            COALESCE(c.name, 'Walk-in') || COALESCE(' - ' || i.invoice_no, ' - ' || g.job_no, '') AS text
       FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN grill_jobs g ON g.id = p.job_id
      WHERE p.direction = 'in' AND p.pay_date = ?
     UNION ALL
     SELECT p.id, 'out', p.mode, p.amount, p.reference, 'Paid to ' || s.name
       FROM payments p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.direction = 'out' AND p.pay_date = ?
     UNION ALL
     SELECT NULL, 'out', e.mode, e.amount, '', 'Expense: ' || e.category || COALESCE(' - ' || NULLIF(e.note, ''), '')
       FROM expenses e WHERE e.exp_date = ?`, [date, date, date]);

  var byMode = {};
  PAY_MODES.forEach(function (m) { byMode[m] = { in: 0, out: 0 }; });
  rows.forEach(function (r) { byMode[r.mode] = byMode[r.mode] || { in: 0, out: 0 }; byMode[r.mode][r.dir] += r.amount; });
  var sales = await get('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM invoices WHERE invoice_date = ?', [date]);
  res.render('daybook', { title: 'Daily Cash / UPI Register', date, rows, byMode, sales });
}));

// ===========================================================================
// Reports: profit & loss, GST summary, outstanding
// ===========================================================================

router.get('/reports', wrap(async function (req, res) {
  var from = req.query.from || monthStart(req);
  var to = req.query.to || req.app.locals.today();

  var shop = await get(
    `SELECT COALESCE(SUM(it.qty * it.rate * (1 - it.disc_pct / 100.0)), 0) AS revenue,
            COALESCE(SUM(it.qty * it.cost), 0) AS cost
       FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
      WHERE i.invoice_date BETWEEN ? AND ?`, [from, to]);
  var byType = await all(
    `SELECT p.type, SUM(it.qty * it.rate * (1 - it.disc_pct / 100.0)) AS revenue, SUM(it.qty * it.cost) AS cost
       FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id JOIN products p ON p.id = it.product_id
      WHERE i.invoice_date BETWEEN ? AND ? GROUP BY p.type`, [from, to]);

  // Grill jobs booked in the period (not cancelled). Material cost uses the
  // material actually issued, valued at the current purchase price.
  var grill = await get(
    `SELECT COUNT(*) AS jobs, COALESCE(SUM(g.agreed_price), 0) AS revenue,
            COALESCE(SUM((SELECT SUM(m.issued_qty * p.purchase_price) FROM grill_materials m
                            JOIN products p ON p.id = m.product_id WHERE m.job_id = g.id)), 0) AS cost
       FROM grill_jobs g
      WHERE date(g.created_at) BETWEEN ? AND ? AND g.status <> 'Cancelled'`, [from, to]);

  var expenses = await all(
    `SELECT category, SUM(amount) AS amount FROM expenses WHERE exp_date BETWEEN ? AND ?
      GROUP BY category ORDER BY amount DESC`, [from, to]);
  var expenseTotal = expenses.reduce(function (s, e) { return s + e.amount; }, 0);

  var gst = {
    collected: (await get('SELECT COALESCE(SUM(tax), 0) AS v FROM invoices WHERE invoice_date BETWEEN ? AND ?', [from, to])).v,
    paid: (await get('SELECT COALESCE(SUM(tax), 0) AS v FROM purchases WHERE purchase_date BETWEEN ? AND ?', [from, to])).v
  };
  var cash = await all(
    `SELECT mode, SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END) AS received,
            SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END) AS paid
       FROM payments WHERE pay_date BETWEEN ? AND ? GROUP BY mode`, [from, to]);

  var receivables = await all(
    `SELECT * FROM (SELECT c.id, c.name, c.phone, ${CUSTOMER_DUE} AS due FROM customers c)
      WHERE due > 0.009 ORDER BY due DESC`);
  var payables = await all(
    `SELECT * FROM (SELECT s.id, s.name, s.phone, s.credit_days, ${SUPPLIER_DUE} AS due FROM suppliers s)
      WHERE due > 0.009 ORDER BY due DESC`);

  var grossProfit = (shop.revenue - shop.cost) + (grill.revenue - grill.cost);
  res.render('reports', {
    title: 'Reports', from, to, shop, byType, grill, expenses, expenseTotal, gst, cash,
    receivables, payables, grossProfit, netProfit: grossProfit - expenseTotal
  });
}));

module.exports = router;
