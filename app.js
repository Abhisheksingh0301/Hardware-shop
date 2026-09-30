// Load settings from .env before anything else reads process.env
require('dotenv').config({ quiet: true });

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var inventoryRouter = require('./routes/inventory');
var salesRouter = require('./routes/sales');
var grillRouter = require('./routes/grill');
var accountsRouter = require('./routes/accounts');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Shop details from .env, printed on invoices, job cards and receipts
var env = process.env;
app.locals.shop = {
  name: env.SHOP_NAME || 'Hardware Shop',
  tagline: env.SHOP_TAGLINE || '',
  address: env.SHOP_ADDRESS || '',
  phone: env.SHOP_PHONE || '',
  email: env.SHOP_EMAIL || '',
  gstin: env.SHOP_GSTIN || '',
  upiId: env.SHOP_UPI_ID || '',
  upiName: env.SHOP_UPI_NAME || env.SHOP_NAME || '',
  bankName: env.BANK_NAME || '',
  bankAccount: env.BANK_ACCOUNT_NO || '',
  bankIfsc: env.BANK_IFSC || '',
  invoiceFooter: env.INVOICE_FOOTER || 'Thank you for your business.'
};

// Helpers available in every view
app.locals.money = function (n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
app.locals.qty = function (n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
};
app.locals.today = function () {
  var d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

// Success / error messages passed along a redirect as ?msg= or ?err=
app.use(function (req, res, next) {
  res.locals.msg = req.query.msg || '';
  res.locals.err = req.query.err || '';
  res.locals.path = req.path;
  res.locals.query = req.query;
  next();
});

app.use('/', indexRouter);
app.use('/inventory', inventoryRouter);
app.use('/', salesRouter);
app.use('/grill', grillRouter);
app.use('/accounts', accountsRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error', { title: 'Error' });
});

module.exports = app;
