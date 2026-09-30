// ---------------------------------------------------------------------------
// routes/sales.js - sales invoices (paint / hardware) and purchases.
// Saving a bill also moves stock and records the payment, all in one
// transaction.
// ---------------------------------------------------------------------------

var express = require('express');
var QRCode = require('qrcode');
var { run, get, all, wrap, num, list, round2, transaction, moveStock, nextNumber, PAY_MODES } = require('../db');

var router = express.Router();

// Turns the parallel arrays posted by the line-items table into row objects.
function readLines(body) {
  var ids = list(body.product_id);
  var qty = list(body.qty), rate = list(body.rate), disc = list(body.disc), gst = list(body.gst);
  var lines = [];
  ids.forEach(function (id, i) {
    if (!id) return;
    lines.push({ product_id: parseInt(id, 10), qty: num(qty[i]), rate: num(rate[i]), disc: num(disc[i]), gst: num(gst[i]) });
  });
  return lines;
}

// Adds amount fields to each line and returns the bill totals.
function price(lines) {
  var t = { subtotal: 0, discount: 0, tax: 0, total: 0 };
  lines.forEach(function (l) {
    var gross = l.qty * l.rate;
    var d = gross * l.disc / 100;
    var tax = (gross - d) * l.gst / 100;
    l.amount = round2(gross - d + tax);
    t.subtotal += gross; t.discount += d; t.tax += tax; t.total += l.amount;
  });
  Object.keys(t).forEach(function (k) { t[k] = round2(t[k]); });
  return t;
}

// QR image (data URL) that opens any UPI app with our UPI ID, the amount
// and the invoice number already filled in. Null when no UPI ID is set.
function upiQr(shop, amount, note) {
  if (!shop.upiId || amount <= 0) return Promise.resolve(null);
  var link = 'upi://pay?pa=' + encodeURIComponent(shop.upiId) +
    '&pn=' + encodeURIComponent(shop.upiName) +
    '&am=' + amount.toFixed(2) + '&cu=INR&tn=' + encodeURIComponent(note);
  return QRCode.toDataURL(link, { width: 160, margin: 1 });
}

function pickMode(m) {
  return PAY_MODES.indexOf(m) >= 0 ? m : 'Cash';
}

// ===========================================================================
// Sales invoices
// ===========================================================================

var INVOICE_PAID = `COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)`;

router.get('/invoices', wrap(async function (req, res) {
  var from = req.query.from || req.app.locals.today().slice(0, 8) + '01';
  var to = req.query.to || req.app.locals.today();
  var q = (req.query.q || '').trim();
  var rows = await all(
    `SELECT i.*, COALESCE(c.name, i.customer_name, 'Walk-in') AS customer, ${INVOICE_PAID} AS paid
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.invoice_date BETWEEN ? AND ?
        AND (i.invoice_no LIKE ? OR COALESCE(c.name, i.customer_name, '') LIKE ?)
      ORDER BY i.invoice_date DESC, i.id DESC`, [from, to, '%' + q + '%', '%' + q + '%']);
  res.render('invoices', { title: 'Sales Invoices', rows, from, to, q });
}));

async function invoiceForm(res, data, error) {
  res.render('invoice_form', {
    title: 'New Sale', error, data, PAY_MODES,
    customers: await all('SELECT id, name, phone FROM customers ORDER BY name'),
    products: await all(
      `SELECT p.*, b.name AS brand FROM products p LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.active = 1 AND p.type IN ('paint', 'hardware') ORDER BY p.type DESC, p.name`)
  });
}

router.get('/invoices/new', wrap(async function (req, res) {
  await invoiceForm(res, { invoice_date: req.app.locals.today(), customer_id: req.query.customer || '', lines: [], mode: 'Cash' }, '');
}));

router.post('/invoices', wrap(async function (req, res) {
  var b = req.body;
  var lines = readLines(b);
  var totals = price(lines);
  var data = {
    customer_id: b.customer_id ? parseInt(b.customer_id, 10) : null,
    customer_name: (b.customer_name || '').trim(),
    invoice_date: b.invoice_date || req.app.locals.today(),
    notes: (b.notes || '').trim(),
    paid: num(b.paid), mode: pickMode(b.mode), reference: (b.reference || '').trim(),
    lines
  };

  // --- validation ---
  var error = '';
  if (!lines.length) error = 'Add at least one item.';
  else if (lines.some(function (l) { return l.qty <= 0 || l.rate < 0 || l.disc < 0 || l.disc > 100; }))
    error = 'Every line needs a quantity above zero and a valid rate / discount.';
  else if (data.paid < 0 || data.paid > totals.total) error = 'Amount paid must be between 0 and the bill total.';
  else if (data.paid < totals.total && !data.customer_id)
    error = 'Choose a customer for a credit (unpaid / part-paid) sale.';

  // Stock check, adding up repeat lines of the same product
  if (!error) {
    var need = {};
    lines.forEach(function (l) { need[l.product_id] = (need[l.product_id] || 0) + l.qty; });
    for (var pid in need) {
      var p = await get('SELECT name, stock, unit FROM products WHERE id = ? AND active = 1', [pid]);
      if (!p) { error = 'A selected product no longer exists.'; break; }
      if (p.stock < need[pid]) { error = `Not enough stock of ${p.name}: only ${p.stock} ${p.unit} available.`; break; }
    }
  }
  if (error) return invoiceForm(res, data, error);

  var id = await transaction(async function () {
    var no = await nextNumber('invoices', 'invoice_no', 'INV', 4);
    var r = await run(
      `INSERT INTO invoices (invoice_no, customer_id, customer_name, invoice_date, subtotal, discount, tax, total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no, data.customer_id, data.customer_name || null, data.invoice_date, totals.subtotal, totals.discount, totals.tax, totals.total, data.notes]);
    for (var l of lines) {
      var p = await get('SELECT purchase_price FROM products WHERE id = ?', [l.product_id]);
      await run(
        `INSERT INTO invoice_items (invoice_id, product_id, qty, rate, cost, disc_pct, gst_rate, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [r.id, l.product_id, l.qty, l.rate, p.purchase_price, l.disc, l.gst, l.amount]);
      await moveStock(l.product_id, -l.qty, 'sale', r.id, no);
    }
    if (data.paid > 0) {
      await run(
        `INSERT INTO payments (pay_date, direction, customer_id, invoice_id, amount, mode, reference, note)
         VALUES (?, 'in', ?, ?, ?, ?, ?, ?)`,
        [data.invoice_date, data.customer_id, r.id, data.paid, data.mode, data.reference, 'Against ' + no]);
    }
    return r.id;
  });
  res.redirect('/invoices/' + id + '?msg=' + encodeURIComponent('Invoice saved.'));
}));

router.get('/invoices/:id', wrap(async function (req, res) {
  var inv = await get(
    `SELECT i.*, c.name AS cust_name, c.phone, c.address, c.gstin, ${INVOICE_PAID} AS paid
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`, [req.params.id]);
  if (!inv) return res.redirect('/invoices');
  var items = await all(
    `SELECT it.*, p.name, p.size, p.unit, b.name AS brand FROM invoice_items it
       JOIN products p ON p.id = it.product_id LEFT JOIN brands b ON b.id = p.brand_id
      WHERE it.invoice_id = ? ORDER BY it.id`, [inv.id]);
  var payments = await all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY pay_date, id', [inv.id]);
  var qr = await upiQr(req.app.locals.shop, round2(inv.total - inv.paid), 'Invoice ' + inv.invoice_no);
  res.render('invoice_view', { title: 'Invoice ' + inv.invoice_no, inv, items, payments, PAY_MODES, qr });
}));

// Cancelling a sale puts the stock back and removes its payments
router.post('/invoices/:id/delete', wrap(async function (req, res) {
  var inv = await get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.redirect('/invoices');
  await transaction(async function () {
    var items = await all('SELECT product_id, qty FROM invoice_items WHERE invoice_id = ?', [inv.id]);
    for (var it of items) await moveStock(it.product_id, it.qty, 'sale', inv.id, 'Cancelled ' + inv.invoice_no);
    await run('DELETE FROM invoices WHERE id = ?', [inv.id]);
  });
  res.redirect('/invoices?msg=' + encodeURIComponent('Invoice ' + inv.invoice_no + ' cancelled and stock returned.'));
}));

// ===========================================================================
// Purchases
// ===========================================================================

var PURCHASE_PAID = `COALESCE((SELECT SUM(amount) FROM payments WHERE purchase_id = pu.id), 0)`;

router.get('/purchases', wrap(async function (req, res) {
  var from = req.query.from || req.app.locals.today().slice(0, 8) + '01';
  var to = req.query.to || req.app.locals.today();
  var q = (req.query.q || '').trim();
  var rows = await all(
    `SELECT pu.*, s.name AS supplier, ${PURCHASE_PAID} AS paid
       FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
      WHERE pu.purchase_date BETWEEN ? AND ? AND (IFNULL(pu.invoice_no, '') LIKE ? OR s.name LIKE ?)
      ORDER BY pu.purchase_date DESC, pu.id DESC`, [from, to, '%' + q + '%', '%' + q + '%']);
  res.render('purchases', { title: 'Purchases', rows, from, to, q });
}));

async function purchaseForm(res, data, error) {
  res.render('purchase_form', {
    title: 'New Purchase', error, data, PAY_MODES,
    suppliers: await all('SELECT id, name FROM suppliers ORDER BY name'),
    products: await all(
      `SELECT p.*, b.name AS brand FROM products p LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.active = 1 ORDER BY p.type, p.name`)
  });
}

router.get('/purchases/new', wrap(async function (req, res) {
  await purchaseForm(res, { purchase_date: req.app.locals.today(), supplier_id: req.query.supplier || '', lines: [], mode: 'Cash' }, '');
}));

router.post('/purchases', wrap(async function (req, res) {
  var b = req.body;
  var lines = readLines(b);
  lines.forEach(function (l) { l.disc = 0; });
  var totals = price(lines);
  var data = {
    supplier_id: b.supplier_id ? parseInt(b.supplier_id, 10) : null,
    invoice_no: (b.invoice_no || '').trim(),
    purchase_date: b.purchase_date || req.app.locals.today(),
    notes: (b.notes || '').trim(),
    paid: num(b.paid), mode: pickMode(b.mode), reference: (b.reference || '').trim(),
    lines
  };

  var error = !data.supplier_id ? 'Choose a supplier.' :
    !lines.length ? 'Add at least one item.' :
    lines.some(function (l) { return l.qty <= 0 || l.rate < 0; }) ? 'Every line needs a quantity above zero and a valid rate.' :
    data.paid < 0 || data.paid > totals.total ? 'Amount paid must be between 0 and the bill total.' : '';
  if (error) return purchaseForm(res, data, error);

  var id = await transaction(async function () {
    var r = await run(
      `INSERT INTO purchases (supplier_id, invoice_no, purchase_date, subtotal, tax, total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.supplier_id, data.invoice_no, data.purchase_date, totals.subtotal, totals.tax, totals.total, data.notes]);
    for (var l of lines) {
      await run(
        `INSERT INTO purchase_items (purchase_id, product_id, qty, rate, gst_rate, amount) VALUES (?, ?, ?, ?, ?, ?)`,
        [r.id, l.product_id, l.qty, l.rate, l.gst, l.amount]);
      await moveStock(l.product_id, l.qty, 'purchase', r.id, 'Purchase ' + (data.invoice_no || '#' + r.id));
      // Remember the latest buying rate
      await run('UPDATE products SET purchase_price = ? WHERE id = ?', [l.rate, l.product_id]);
    }
    if (data.paid > 0) {
      await run(
        `INSERT INTO payments (pay_date, direction, supplier_id, purchase_id, amount, mode, reference, note)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?)`,
        [data.purchase_date, data.supplier_id, r.id, data.paid, data.mode, data.reference, 'Against purchase ' + (data.invoice_no || '#' + r.id)]);
    }
    return r.id;
  });
  res.redirect('/purchases/' + id + '?msg=' + encodeURIComponent('Purchase saved and stock updated.'));
}));

router.get('/purchases/:id', wrap(async function (req, res) {
  var pu = await get(
    `SELECT pu.*, s.name AS supplier, s.phone, s.address, s.gstin, ${PURCHASE_PAID} AS paid
       FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id WHERE pu.id = ?`, [req.params.id]);
  if (!pu) return res.redirect('/purchases');
  var items = await all(
    `SELECT it.*, p.name, p.size, p.unit, p.type FROM purchase_items it
       JOIN products p ON p.id = it.product_id WHERE it.purchase_id = ? ORDER BY it.id`, [pu.id]);
  var payments = await all('SELECT * FROM payments WHERE purchase_id = ? ORDER BY pay_date, id', [pu.id]);
  res.render('purchase_view', { title: 'Purchase', pu, items, payments, PAY_MODES });
}));

// Purchase return / wrong entry: take the stock back out
router.post('/purchases/:id/delete', wrap(async function (req, res) {
  var pu = await get('SELECT * FROM purchases WHERE id = ?', [req.params.id]);
  if (!pu) return res.redirect('/purchases');
  var items = await all(
    `SELECT it.product_id, SUM(it.qty) AS qty, p.name, p.stock FROM purchase_items it
       JOIN products p ON p.id = it.product_id WHERE it.purchase_id = ? GROUP BY it.product_id`, [pu.id]);
  var short = items.find(function (it) { return it.stock < it.qty; });
  if (short) {
    return res.redirect('/purchases/' + pu.id + '?err=' +
      encodeURIComponent('Cannot delete: ' + short.name + ' has already been sold or used.'));
  }
  await transaction(async function () {
    for (var it of items) await moveStock(it.product_id, -it.qty, 'purchase', pu.id, 'Deleted purchase ' + (pu.invoice_no || '#' + pu.id));
    await run('DELETE FROM purchases WHERE id = ?', [pu.id]);
  });
  res.redirect('/purchases?msg=' + encodeURIComponent('Purchase deleted and stock reduced.'));
}));

module.exports = router;
