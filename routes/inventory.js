// ---------------------------------------------------------------------------
// routes/inventory.js - product master (paint, hardware, raw material),
// stock adjustments and the inventory register.
// ---------------------------------------------------------------------------

var express = require('express');
var db = require('../db');
var { run, get, all, wrap, num, transaction, moveStock, PRODUCT_TYPES, CATEGORIES, UNITS } = db;

var router = express.Router();

function validType(t) {
  return PRODUCT_TYPES[t] ? t : '';
}

async function formLists() {
  return {
    brands: await all('SELECT id, name FROM brands ORDER BY name'),
    suppliers: await all('SELECT id, name FROM suppliers ORDER BY name'),
    PRODUCT_TYPES, CATEGORIES, UNITS
  };
}

// List, filtered by type / search / low stock
router.get('/', wrap(async function (req, res) {
  var type = validType(req.query.type);
  var q = (req.query.q || '').trim();
  var low = req.query.low === '1';
  var where = ['p.active = 1', '(p.name LIKE ? OR IFNULL(p.category, \'\') LIKE ? OR IFNULL(b.name, \'\') LIKE ?)'];
  var params = ['%' + q + '%', '%' + q + '%', '%' + q + '%'];
  if (type) { where.push('p.type = ?'); params.push(type); }
  if (low) where.push('p.stock <= p.min_stock');

  var rows = await all(
    `SELECT p.*, b.name AS brand FROM products p LEFT JOIN brands b ON b.id = p.brand_id
      WHERE ${where.join(' AND ')} ORDER BY p.type, p.category, p.name`, params);
  var value = rows.reduce(function (s, r) { return s + r.stock * r.purchase_price; }, 0);
  res.render('products', { title: type ? PRODUCT_TYPES[type] + ' Stock' : 'Inventory', rows, type, q, low, value, PRODUCT_TYPES });
}));

router.get('/new', wrap(async function (req, res) {
  var row = { type: validType(req.query.type) || 'hardware', unit: 'Piece', gst_rate: 18 };
  res.render('product_form', Object.assign({ title: 'New Product', row, error: '' }, await formLists()));
}));

router.get('/:id/edit', wrap(async function (req, res) {
  var row = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!row) return res.redirect('/inventory');
  res.render('product_form', Object.assign({ title: 'Edit Product', row, error: '' }, await formLists()));
}));

router.post('/save', wrap(async function (req, res) {
  var b = req.body;
  var id = parseInt(b.id, 10);
  var p = {
    type: validType(b.type), name: (b.name || '').trim(), category: (b.category || '').trim(),
    brand_id: b.brand_id || null, size: (b.size || '').trim(), unit: b.unit || 'Piece',
    purchase_price: num(b.purchase_price), selling_price: num(b.selling_price), gst_rate: num(b.gst_rate),
    min_stock: num(b.min_stock), supplier_id: b.supplier_id || null
  };
  var error = !p.type ? 'Choose a product type.' : !p.name ? 'Product name is required.' :
    p.purchase_price < 0 || p.selling_price < 0 ? 'Prices cannot be negative.' : '';
  if (error) {
    p.id = id;
    return res.render('product_form', Object.assign({ title: 'Product', row: p, error }, await formLists()));
  }

  var cols = Object.keys(p);
  var values = cols.map(function (c) { return p[c]; });
  if (id) {
    await run(`UPDATE products SET ${cols.map(function (c) { return c + ' = ?'; }).join(', ')} WHERE id = ?`, values.concat(id));
  } else {
    var opening = num(b.opening_stock);
    id = await transaction(async function () {
      var r = await run(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(function () { return '?'; }).join(', ')})`, values);
      if (opening > 0) await moveStock(r.id, opening, 'adjust', null, 'Opening stock');
      return r.id;
    });
  }
  res.redirect('/inventory/' + id + '?msg=' + encodeURIComponent('Product saved.'));
}));

// Hides the product from lists and billing (history stays intact)
router.post('/:id/delete', wrap(async function (req, res) {
  var p = await get('SELECT type FROM products WHERE id = ?', [req.params.id]);
  await run('UPDATE products SET active = 0 WHERE id = ?', [req.params.id]);
  res.redirect('/inventory?type=' + (p ? p.type : '') + '&msg=' + encodeURIComponent('Product removed.'));
}));

// Manual stock correction: damaged, found extra, physical count...
router.post('/:id/adjust', wrap(async function (req, res) {
  var qty = num(req.body.qty);
  var note = (req.body.note || '').trim();
  var p = await get('SELECT stock FROM products WHERE id = ?', [req.params.id]);
  var back = '/inventory/' + req.params.id;
  if (!p || !qty) return res.redirect(back + '?err=' + encodeURIComponent('Enter a quantity to add (+) or remove (-).'));
  if (p.stock + qty < 0) return res.redirect(back + '?err=' + encodeURIComponent('Stock cannot go below zero.'));
  await transaction(function () { return moveStock(req.params.id, qty, 'adjust', null, note || 'Manual adjustment'); });
  res.redirect(back + '?msg=' + encodeURIComponent('Stock updated.'));
}));

// Inventory register - every stock movement
router.get('/register', wrap(async function (req, res) {
  var from = req.query.from || req.app.locals.today().slice(0, 8) + '01';
  var to = req.query.to || req.app.locals.today();
  var type = validType(req.query.type);
  var rows = await all(
    `SELECT m.*, p.name, p.unit, p.type FROM stock_moves m JOIN products p ON p.id = m.product_id
      WHERE date(m.created_at) BETWEEN ? AND ? ${type ? 'AND p.type = ?' : ''}
      ORDER BY m.id DESC LIMIT 500`, type ? [from, to, type] : [from, to]);
  res.render('stock_register', { title: 'Inventory Register', rows, from, to, type, product: null, PRODUCT_TYPES });
}));

// One product with its own stock history
router.get('/:id', wrap(async function (req, res) {
  var product = await get(
    `SELECT p.*, b.name AS brand, s.name AS supplier FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ?`, [req.params.id]);
  if (!product) return res.redirect('/inventory');
  var rows = await all(
    `SELECT m.*, p.name, p.unit, p.type FROM stock_moves m JOIN products p ON p.id = m.product_id
      WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`, [product.id]);
  res.render('stock_register', { title: product.name, rows, product, from: '', to: '', type: '', PRODUCT_TYPES });
}));

module.exports = router;
