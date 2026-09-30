// ---------------------------------------------------------------------------
// routes/index.js - dashboard, customers, suppliers and paint brands
// ---------------------------------------------------------------------------

var express = require('express');
var { run, get, all, wrap, num, CUSTOMER_DUE, SUPPLIER_DUE } = require('../db');

var router = express.Router();

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/', wrap(async function (req, res) {
  var today = req.app.locals.today();
  var month = today.slice(0, 7);

  var sales = await get(
    `SELECT COALESCE(SUM(CASE WHEN invoice_date = ? THEN total END), 0) AS today,
            COALESCE(SUM(CASE WHEN substr(invoice_date, 1, 7) = ? THEN total END), 0) AS month
       FROM invoices`, [today, month]);
  var collected = await get(
    `SELECT COALESCE(SUM(amount), 0) AS today FROM payments WHERE direction = 'in' AND pay_date = ?`, [today]);
  var receivable = await get(`SELECT COALESCE(SUM(${CUSTOMER_DUE}), 0) AS v FROM customers c`);
  var payable = await get(`SELECT COALESCE(SUM(${SUPPLIER_DUE}), 0) AS v FROM suppliers s`);

  var lowStock = await all(
    `SELECT id, name, type, stock, min_stock, unit FROM products
      WHERE active = 1 AND stock <= min_stock ORDER BY type, name LIMIT 15`);
  var jobs = await all(
    `SELECT g.id, g.job_no, g.grill_type, g.status, g.expected_date, c.name AS customer
       FROM grill_jobs g JOIN customers c ON c.id = g.customer_id
      WHERE g.status NOT IN ('Completed', 'Cancelled')
      ORDER BY g.expected_date IS NULL, g.expected_date LIMIT 10`);
  var invoices = await all(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.total,
            COALESCE(c.name, i.customer_name, 'Walk-in') AS customer
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      ORDER BY i.id DESC LIMIT 8`);

  res.render('dashboard', {
    title: 'Dashboard', sales, collected, receivable: receivable.v, payable: payable.v,
    lowStock, jobs, invoices
  });
}));

// ---------------------------------------------------------------------------
// Customers and suppliers share the same list / form / ledger views.
// ---------------------------------------------------------------------------

var PARTIES = {
  customers: {
    table: 'customers', alias: 'c', due: CUSTOMER_DUE, label: 'Customer', plural: 'Customers',
    fields: ['name', 'phone', 'address', 'gstin', 'opening_balance']
  },
  suppliers: {
    table: 'suppliers', alias: 's', due: SUPPLIER_DUE, label: 'Supplier', plural: 'Suppliers',
    fields: ['name', 'contact_person', 'phone', 'address', 'gstin', 'products_supplied', 'credit_days', 'opening_balance']
  }
};

function readParty(p, body) {
  var data = {};
  p.fields.forEach(function (f) {
    data[f] = f === 'opening_balance' || f === 'credit_days' ? num(body[f]) : (body[f] || '').trim();
  });
  return data;
}

Object.keys(PARTIES).forEach(function (kind) {
  var p = PARTIES[kind];

  router.get('/' + kind, wrap(async function (req, res) {
    var q = (req.query.q || '').trim();
    var rows = await all(
      `SELECT ${p.alias}.*, ${p.due} AS due FROM ${p.table} ${p.alias}
        WHERE ${p.alias}.name LIKE ? OR IFNULL(${p.alias}.phone, '') LIKE ?
        ORDER BY ${p.alias}.name`, ['%' + q + '%', '%' + q + '%']);
    res.render('party_list', { title: p.plural, kind, p, rows, q });
  }));

  router.get('/' + kind + '/new', function (req, res) {
    res.render('party_form', { title: 'New ' + p.label, kind, p, row: {}, error: '' });
  });

  router.get('/' + kind + '/:id/edit', wrap(async function (req, res) {
    var row = await get(`SELECT * FROM ${p.table} WHERE id = ?`, [req.params.id]);
    if (!row) return res.redirect('/' + kind);
    res.render('party_form', { title: 'Edit ' + p.label, kind, p, row, error: '' });
  }));

  router.post('/' + kind + '/save', wrap(async function (req, res) {
    var data = readParty(p, req.body);
    var id = parseInt(req.body.id, 10);
    if (!data.name) {
      data.id = id;
      return res.render('party_form', { title: p.label, kind, p, row: data, error: 'Name is required.' });
    }
    var values = p.fields.map(function (f) { return data[f]; });
    if (id) {
      await run(`UPDATE ${p.table} SET ${p.fields.map(function (f) { return f + ' = ?'; }).join(', ')} WHERE id = ?`,
        values.concat(id));
    } else {
      var r = await run(`INSERT INTO ${p.table} (${p.fields.join(', ')}) VALUES (${p.fields.map(function () { return '?'; }).join(', ')})`, values);
      id = r.id;
    }
    res.redirect('/' + kind + '/' + id + '?msg=' + encodeURIComponent(p.label + ' saved.'));
  }));

  router.post('/' + kind + '/:id/delete', wrap(async function (req, res) {
    try {
      await run(`DELETE FROM ${p.table} WHERE id = ?`, [req.params.id]);
      res.redirect('/' + kind + '?msg=' + encodeURIComponent(p.label + ' deleted.'));
    } catch (e) {
      res.redirect('/' + kind + '/' + req.params.id + '?err=' +
        encodeURIComponent('This ' + p.label.toLowerCase() + ' has bills or payments and cannot be deleted.'));
    }
  }));

  // Ledger: every bill and payment with a running balance
  router.get('/' + kind + '/:id', wrap(async function (req, res) {
    var row = await get(`SELECT ${p.alias}.*, ${p.due} AS due FROM ${p.table} ${p.alias} WHERE id = ?`, [req.params.id]);
    if (!row) return res.redirect('/' + kind);
    var entries = kind === 'customers' ? await customerEntries(row.id) : await supplierEntries(row.id);
    entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order; });
    var balance = row.opening_balance;
    entries.forEach(function (e) { balance += e.plus - e.minus; e.balance = balance; });
    res.render('party_ledger', { title: row.name, kind, p, row, entries });
  }));
});

async function customerEntries(id) {
  var invoices = await all(`SELECT id, invoice_no, invoice_date, total FROM invoices WHERE customer_id = ?`, [id]);
  var jobs = await all(`SELECT id, job_no, substr(created_at, 1, 10) AS d, agreed_price, grill_type
                          FROM grill_jobs WHERE customer_id = ? AND status <> 'Cancelled'`, [id]);
  var pays = await all(`SELECT * FROM payments WHERE direction = 'in' AND customer_id = ?`, [id]);
  return [].concat(
    invoices.map(function (r) {
      return { date: r.invoice_date, order: 1, text: 'Invoice ' + r.invoice_no, link: '/invoices/' + r.id, plus: r.total, minus: 0 };
    }),
    jobs.map(function (r) {
      return { date: r.d, order: 1, text: 'Grill job ' + r.job_no + ' (' + (r.grill_type || '') + ')', link: '/grill/' + r.id, plus: r.agreed_price, minus: 0 };
    }),
    pays.map(function (r) {
      return { date: r.pay_date, order: 2, text: 'Payment - ' + r.mode + (r.reference ? ' (' + r.reference + ')' : ''), link: '', plus: 0, minus: r.amount };
    })
  );
}

async function supplierEntries(id) {
  var purchases = await all(`SELECT id, invoice_no, purchase_date, total FROM purchases WHERE supplier_id = ?`, [id]);
  var pays = await all(`SELECT * FROM payments WHERE direction = 'out' AND supplier_id = ?`, [id]);
  return [].concat(
    purchases.map(function (r) {
      return { date: r.purchase_date, order: 1, text: 'Purchase ' + (r.invoice_no || '#' + r.id), link: '/purchases/' + r.id, plus: r.total, minus: 0 };
    }),
    pays.map(function (r) {
      return { date: r.pay_date, order: 2, text: 'Payment - ' + r.mode + (r.reference ? ' (' + r.reference + ')' : ''), link: '', plus: 0, minus: r.amount };
    })
  );
}

// ---------------------------------------------------------------------------
// Paint brands (list and add/edit form on one page)
// ---------------------------------------------------------------------------

router.get('/brands', wrap(async function (req, res) {
  var rows = await all(
    `SELECT b.*, s.name AS supplier, s.phone AS supplier_phone,
            (SELECT COUNT(*) FROM products WHERE brand_id = b.id) AS products
       FROM brands b LEFT JOIN suppliers s ON s.id = b.supplier_id ORDER BY b.name`);
  var edit = req.query.edit ? await get('SELECT * FROM brands WHERE id = ?', [req.query.edit]) : null;
  var suppliers = await all('SELECT id, name FROM suppliers ORDER BY name');
  res.render('brands', { title: 'Paint Brands', rows, edit: edit || {}, suppliers });
}));

router.post('/brands/save', wrap(async function (req, res) {
  var b = req.body;
  var values = [(b.name || '').trim(), b.supplier_id || null, num(b.dealer_discount),
    b.credit_terms || '', b.payment_terms || '', b.notes || ''];
  if (!values[0]) return res.redirect('/brands?err=' + encodeURIComponent('Brand name is required.'));
  try {
    if (b.id) {
      await run(`UPDATE brands SET name = ?, supplier_id = ?, dealer_discount = ?, credit_terms = ?,
                 payment_terms = ?, notes = ? WHERE id = ?`, values.concat(b.id));
    } else {
      await run(`INSERT INTO brands (name, supplier_id, dealer_discount, credit_terms, payment_terms, notes)
                 VALUES (?, ?, ?, ?, ?, ?)`, values);
    }
  } catch (e) {
    return res.redirect('/brands?err=' + encodeURIComponent('A brand with this name already exists.'));
  }
  res.redirect('/brands?msg=' + encodeURIComponent('Brand saved.'));
}));

router.post('/brands/:id/delete', wrap(async function (req, res) {
  try {
    await run('DELETE FROM brands WHERE id = ?', [req.params.id]);
    res.redirect('/brands?msg=' + encodeURIComponent('Brand deleted.'));
  } catch (e) {
    res.redirect('/brands?err=' + encodeURIComponent('Brand is used by products and cannot be deleted.'));
  }
}));

module.exports = router;
