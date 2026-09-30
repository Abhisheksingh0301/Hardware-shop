// ---------------------------------------------------------------------------
// public/javascripts/main.js - the only browser script.
//  1. Line-item tables (sale, purchase, grill material): add / remove rows,
//     fill rate and GST from the chosen product, live totals.
//  2. Confirm before dangerous buttons (data-confirm).
//  3. Copy a value from a chosen <option> into an empty field (data-fill).
// The server always recalculates totals; these are only a preview.
// ---------------------------------------------------------------------------

(function () {
  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function rupees(n) {
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- 1. line items ----------
  document.querySelectorAll('.lines-box').forEach(function (box) {
    var mode = box.dataset.mode;            // sale | purchase | material
    var tbody = box.querySelector('tbody');
    var tpl = box.querySelector('template');

    function field(row, name) {
      return row.querySelector('[name="' + name + '"]');
    }

    function addRow(item) {
      var row = tpl.content.firstElementChild.cloneNode(true);
      tbody.appendChild(row);
      if (item) {
        ['product_id', 'qty', 'rate', 'disc', 'gst'].forEach(function (k) {
          if (field(row, k) && item[k] !== undefined) field(row, k).value = item[k];
        });
      }
      showInfo(row);
      return row;
    }

    // Unit and stock next to the product
    function showInfo(row) {
      var opt = field(row, 'product_id').selectedOptions[0];
      var info = row.querySelector('.info');
      if (!info) return;
      info.textContent = opt && opt.value ? opt.dataset.unit + ' · stock ' + opt.dataset.stock : '';
    }

    function recalc() {
      if (mode === 'material') return;
      var t = { subtotal: 0, discount: 0, tax: 0, total: 0 };
      tbody.querySelectorAll('tr').forEach(function (row) {
        var gross = num(field(row, 'qty').value) * num(field(row, 'rate').value);
        var d = field(row, 'disc') ? gross * num(field(row, 'disc').value) / 100 : 0;
        var tax = (gross - d) * num(field(row, 'gst').value) / 100;
        var amount = gross - d + tax;
        row.querySelector('.amt').textContent = rupees(amount);
        t.subtotal += gross; t.discount += d; t.tax += tax; t.total += amount;
      });
      Object.keys(t).forEach(function (k) {
        var el = box.querySelector('[data-sum="' + k + '"]');
        if (el) el.textContent = rupees(t[k]);
      });
      box.dataset.total = t.total.toFixed(2);
    }

    tbody.addEventListener('change', function (e) {
      var row = e.target.closest('tr');
      if (e.target.name === 'product_id') {
        var opt = e.target.selectedOptions[0];
        if (opt && opt.value) {
          if (field(row, 'rate')) field(row, 'rate').value = mode === 'purchase' ? opt.dataset.buy : opt.dataset.sell;
          if (field(row, 'gst')) field(row, 'gst').value = opt.dataset.gst;
          if (field(row, 'qty') && !field(row, 'qty').value) field(row, 'qty').value = 1;
        }
        showInfo(row);
        // Keep one empty row at the bottom, ready for the next item
        if (row === tbody.lastElementChild && e.target.value) addRow();
      }
      recalc();
    });
    tbody.addEventListener('input', recalc);

    tbody.addEventListener('click', function (e) {
      if (!e.target.classList.contains('remove')) return;
      e.target.closest('tr').remove();
      if (!tbody.children.length) addRow();
      recalc();
    });

    var addBtn = box.querySelector('.add-row');
    if (addBtn) addBtn.addEventListener('click', function () { addRow(); });

    // "Paid in full" copies the grand total into the paid box
    var form = box.closest('form');
    var fullBtn = form && form.querySelector('[data-fill-paid]');
    if (fullBtn) {
      fullBtn.addEventListener('click', function () {
        form.querySelector('[name="paid"]').value = box.dataset.total || 0;
      });
    }

    var items = JSON.parse(box.dataset.items || '[]');
    items.forEach(addRow);
    addRow();
    recalc();
  });

  // ---------- 2. confirm ----------
  document.addEventListener('submit', function (e) {
    var msg = e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // ---------- 3. fill a field from the chosen option ----------
  // <select data-fill="#site_address"><option data-fill-value="...">
  document.querySelectorAll('select[data-fill]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var target = document.querySelector(sel.dataset.fill);
      var opt = sel.selectedOptions[0];
      if (target && opt && !target.value) target.value = opt.dataset.fillValue || '';
    });
  });

  // Payment form: show the customer or supplier box to match the direction
  document.querySelectorAll('[data-direction]').forEach(function (sel) {
    function sync() {
      document.querySelectorAll('[data-show-for]').forEach(function (el) {
        el.hidden = el.dataset.showFor !== sel.value;
      });
    }
    sel.addEventListener('change', sync);
    sync();
  });
})();
