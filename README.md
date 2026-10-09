# HW-Shop

A small web app for running a hardware, paint and grill-fabrication shop. It is built with Node.js, Express, EJS, SQLite and Tailwind CSS v4.

## Features

- **Inventory**: products, brands, stock adjustments and a stock register
- **Sales and purchases**: GST-ready invoices with a UPI QR code, plus purchase bills
- **Parties**: customers and suppliers, with ledgers and outstanding dues
- **Grill jobs**: fabrication job cards, materials used, status tracking and stock issue
- **Accounts**: payments and receipts, expenses, day book and reports
- **Dashboard**: an overview of the shop at a glance

## Getting started

```bash
npm install
cp .env.example .env   # then edit the shop details
npm start
```

Open http://localhost:3000 (or the `PORT` set in `.env`).

## Styling

Pages are styled with Tailwind CSS utility classes in the EJS templates. `src/app.css` holds the Tailwind setup, element defaults and a few shared components (`btn`, `card`, `badge`, `alert`). It compiles to `public/stylesheets/style.css`, which is generated and not committed.

- `npm start` builds the CSS automatically before starting the server.
- `npm run watch:css` rebuilds the CSS on every template change while you work.

## Configuration

All settings live in `.env`. See `.env.example` for the full list:

- `PORT`: server port
- `SHOP_*`: name, address, phone, GSTIN and UPI details printed on invoices
- `BANK_*`: bank details shown on invoices
- `INVOICE_FOOTER`: the footer line on invoices
- `DB_FILE`: optional path to the SQLite database (defaults to `hwshop.db`)

The database and its tables are created automatically the first time the app starts.

## Project structure

```
app.js          Express setup and route mounting
bin/www         Server entry point
db.js           SQLite connection, schema, query helpers
routes/         index (dashboard, parties, brands), inventory, sales, grill, accounts
views/          EJS templates (styled with Tailwind classes)
src/app.css     Tailwind source
public/         Client JS and built CSS
```
