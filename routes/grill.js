// ---------------------------------------------------------------------------
// routes/grill.js - custom grill manufacturing jobs: order + measurements,
// estimated material, material issue from stock, production status,
// advance / balance payments and the printable job card.
// ---------------------------------------------------------------------------

var express = require('express');
var { run, get, all, wrap, num, list, transaction, moveStock, nextNumber, GRILL_STATUSES, GRILL_TYPES, PAY_MODES } = require('../db');

var router = express.Router();

var JOB_PAID = `COALESCE((SELECT SUM(amount) FROM payments WHERE job_id = g.id), 0)`;

var FIELDS = ['customer_id', 'site_address', 'grill_type', 'width', 'height', 'quantity', 'frame_size', 'rod_size',
  'spacing', 'other_measurements', 'design', 'material_spec', 'finish', 'delivery_required',
  'installation_required', 'agreed_price', 'expected_date', 'notes'];

function back(id, key, text) {
  return '/grill/' + id + '?' + key + '=' + encodeURIComponent(text);
}

router.get('/', wrap(async function (req, res) {
  var status = req.query.status || 'open';
  var q = (req.query.q || '').trim();
  var where = ['(g.job_no LIKE ? OR c.name LIKE ? OR IFNULL(c.phone, \'\') LIKE ?)'];
  var params = ['%' + q + '%', '%' + q + '%', '%' + q + '%'];
  if (status === 'open') where.push(`g.status NOT IN ('Completed', 'Cancelled')`);
  else if (status !== 'all') { where.push('g.status = ?'); params.push(status); }
  var rows = await all(
    `SELECT g.*, c.name AS customer, c.phone, ${JOB_PAID} AS paid
       FROM grill_jobs g JOIN customers c ON c.id = g.customer_id
      WHERE ${where.join(' AND ')} ORDER BY g.id DESC`, params);
  res.render('grill_jobs', { title: 'Grill Jobs', rows, status, q, GRILL_STATUSES });
}));

async function jobForm(res, row, error) {
  res.render('grill_form', {
    title: row.id ? 'Edit Job ' + row.job_no : 'New Grill Order', row, error, GRILL_TYPES, PAY_MODES,
    customers: await all('SELECT id, name, phone, address FROM customers ORDER BY name')
  });
}

router.get('/new', wrap(async function (req, res) {
  await jobForm(res, { customer_id: req.query.customer || '', quantity: 1, delivery_required: 1, installation_required: 0, mode: 'Cash' }, '');
}));

router.get('/:id/edit', wrap(async function (req, res) {
  var row = await get('SELECT * FROM grill_jobs WHERE id = ?', [req.params.id]);
  if (!row) return res.redirect('/grill');
  await jobForm(res, row, '');
}));

router.post('/save', wrap(async function (req, res) {
  var b = req.body;
  var id = parseInt(b.id, 10);
  var job = {};
  FIELDS.forEach(function (f) { job[f] = typeof b[f] === 'string' ? b[f].trim() : ''; });
  job.customer_id = parseInt(b.customer_id, 10) || null;
  job.quantity = parseInt(b.quantity, 10) || 1;
  job.agreed_price = num(b.agreed_price);
  job.delivery_required = b.delivery_required ? 1 : 0;
  job.installation_required = b.installation_required ? 1 : 0;
  job.expected_date = b.expected_date || null;
  var advance = id ? 0 : num(b.advance);

  var error = !job.customer_id ? 'Choose a customer (add them under Customers first).' :
    job.agreed_price < 0 ? 'Agreed price cannot be negative.' :
    advance < 0 || (advance > job.agreed_price && job.agreed_price > 0) ? 'Advance cannot be more than the agreed price.' : '';
  if (error) {
    var old = id ? await get('SELECT job_no FROM grill_jobs WHERE id = ?', [id]) : null;
    return jobForm(res, Object.assign(job, { id, job_no: old && old.job_no, advance: b.advance, mode: b.mode }), error);
  }

  var values = FIELDS.map(function (f) { return job[f]; });
  if (id) {
    await run(`UPDATE grill_jobs SET ${FIELDS.map(function (f) { return f + ' = ?'; }).join(', ')} WHERE id = ?`, values.concat(id));
    return res.redirect(back(id, 'msg', 'Job updated.'));
  }

  id = await transaction(async function () {
    var no = await nextNumber('grill_jobs', 'job_no', 'GRILL', 3);
    var r = await run(`INSERT INTO grill_jobs (job_no, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(function () { return '?'; }).join(', ')})`,
      [no].concat(values));
    await run(`INSERT INTO grill_status_log (job_id, status, note) VALUES (?, 'New', 'Order created')`, [r.id]);
    if (advance > 0) {
      await run(
        `INSERT INTO payments (pay_date, direction, customer_id, job_id, amount, mode, reference, note)
         VALUES (date('now','localtime'), 'in', ?, ?, ?, ?, ?, ?)`,
        [job.customer_id, r.id, advance, PAY_MODES.indexOf(b.mode) >= 0 ? b.mode : 'Cash', (b.reference || '').trim(), 'Advance for ' + no]);
    }
    return r.id;
  });
  res.redirect(back(id, 'msg', 'Grill order created.'));
}));

// Job card: everything about one job
router.get('/:id', wrap(async function (req, res) {
  var job = await get(
    `SELECT g.*, c.name AS customer, c.phone, c.address, ${JOB_PAID} AS paid
       FROM grill_jobs g JOIN customers c ON c.id = g.customer_id WHERE g.id = ?`, [req.params.id]);
  if (!job) return res.redirect('/grill');
  var materials = await all(
    `SELECT m.*, p.name, p.unit, p.stock, p.purchase_price FROM grill_materials m
       JOIN products p ON p.id = m.product_id WHERE m.job_id = ? ORDER BY m.id`, [job.id]);
  var log = await all('SELECT * FROM grill_status_log WHERE job_id = ? ORDER BY id', [job.id]);
  var payments = await all('SELECT * FROM payments WHERE job_id = ? ORDER BY pay_date, id', [job.id]);
  var rawProducts = await all(`SELECT * FROM products WHERE active = 1 AND type = 'raw' ORDER BY name`);
  res.render('grill_view', {
    title: 'Job ' + job.job_no, job, materials, log, payments, rawProducts, GRILL_STATUSES, PAY_MODES,
    print: req.query.print || ''
  });
}));

router.post('/:id/status', wrap(async function (req, res) {
  var status = req.body.status;
  if (GRILL_STATUSES.indexOf(status) < 0) return res.redirect(back(req.params.id, 'err', 'Unknown status.'));
  await transaction(async function () {
    await run('UPDATE grill_jobs SET status = ? WHERE id = ?', [status, req.params.id]);
    await run('INSERT INTO grill_status_log (job_id, status, note) VALUES (?, ?, ?)', [req.params.id, status, (req.body.note || '').trim()]);
  });
  res.redirect(back(req.params.id, 'msg', 'Status changed to ' + status + '.'));
}));

// Save the estimated material list (material planning)
router.post('/:id/materials', wrap(async function (req, res) {
  var jobId = req.params.id;
  var ids = list(req.body.product_id), qty = list(req.body.qty);
  var wanted = {};
  ids.forEach(function (pid, i) { if (pid) wanted[pid] = (wanted[pid] || 0) + num(qty[i]); });

  var current = await all('SELECT * FROM grill_materials WHERE job_id = ?', [jobId]);
  var removedIssued = current.find(function (m) { return !(m.product_id in wanted) && m.issued_qty > 0; });
  if (removedIssued) return res.redirect(back(jobId, 'err', 'A material that was already issued cannot be removed. Return it first.'));

  await transaction(async function () {
    for (var m of current) {
      if (!(m.product_id in wanted)) await run('DELETE FROM grill_materials WHERE id = ?', [m.id]);
    }
    for (var pid in wanted) {
      await run(
        `INSERT INTO grill_materials (job_id, product_id, est_qty) VALUES (?, ?, ?)
         ON CONFLICT (job_id, product_id) DO UPDATE SET est_qty = excluded.est_qty`, [jobId, pid, wanted[pid]]);
    }
  });
  res.redirect(back(jobId, 'msg', 'Material estimate saved.'));
}));

// Issue material from stock to this job (negative quantity = return to stock)
router.post('/:id/issue', wrap(async function (req, res) {
  var jobId = req.params.id;
  var qty = num(req.body.qty);
  var m = await get(
    `SELECT m.*, p.name, p.stock, p.unit, g.job_no FROM grill_materials m
       JOIN products p ON p.id = m.product_id JOIN grill_jobs g ON g.id = m.job_id
      WHERE m.job_id = ? AND m.product_id = ?`, [jobId, req.body.product_id]);
  if (!m || !qty) return res.redirect(back(jobId, 'err', 'Choose a material and quantity.'));
  if (qty > m.stock) return res.redirect(back(jobId, 'err', `Only ${m.stock} ${m.unit} of ${m.name} in stock.`));
  if (m.issued_qty + qty < 0) return res.redirect(back(jobId, 'err', 'Cannot return more than was issued.'));

  await transaction(async function () {
    await run('UPDATE grill_materials SET issued_qty = issued_qty + ? WHERE id = ?', [qty, m.id]);
    await moveStock(m.product_id, -qty, 'grill', jobId, (qty > 0 ? 'Issued to ' : 'Returned from ') + m.job_no);
  });
  res.redirect(back(jobId, 'msg', qty > 0 ? 'Material issued.' : 'Material returned to stock.'));
}));

// Only a job with no payments and no issued material can be deleted;
// otherwise mark it Cancelled.
router.post('/:id/delete', wrap(async function (req, res) {
  var id = req.params.id;
  var used = await get(
    `SELECT (SELECT COUNT(*) FROM payments WHERE job_id = ?) AS pays,
            (SELECT COUNT(*) FROM grill_materials WHERE job_id = ? AND issued_qty > 0) AS issued`, [id, id]);
  if (used.pays || used.issued) return res.redirect(back(id, 'err', 'This job has payments or issued material. Set its status to Cancelled instead.'));
  await run('DELETE FROM grill_jobs WHERE id = ?', [id]);
  res.redirect('/grill?msg=' + encodeURIComponent('Job deleted.'));
}));

module.exports = router;
