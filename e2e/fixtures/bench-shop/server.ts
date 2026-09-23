// A tiny, dependency-free HTTP server implementing a fake online shop, used by
// e2e/browser-shop-fixture.spec.ts (a deterministic, LLM-free sanity test driven
// through window.penDesktop.browser) and e2e/bench-browse.spec.ts (the opt-in
// AI-agent benchmark). Plain Node `http` + a handful of inline <script> blocks —
// no build step, no npm dependencies, no client framework.
//
// Flow covered: a cookie-consent banner that blocks real interaction until
// accepted (search submit / nav links / add-to-cart are guarded by a delegated
// listener checking for the banner's DOM node), a header search box with no
// submit button (Enter submits the lone-input form to GET /search?q=...), a
// "Categories" nav item whose dropdown only opens via CSS :hover, a results
// page with client-side brand/price/wireless filters and a sort <select> (all
// driven off one embedded JSON blob, so filtering never round-trips to the
// server), a product page with "Add to cart" (POSTs to /api/cart/add, session
// cart kept server-side against a `sid` cookie), and a cart -> checkout flow
// with server-side validation (re-renders the form with inline errors and the
// caller's own values on any bad input) that records the submitted order in
// memory and redirects to a confirmation page carrying the order number.

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { PRODUCTS, CATEGORIES, findProduct, searchProducts, type Product } from "./products";

export interface OrderItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
}

export interface OrderRecord {
  orderNumber: string;
  fullName: string;
  email: string;
  country: string;
  shipping: "standard" | "express";
  termsAccepted: true;
  items: OrderItem[];
  total: number;
  createdAt: string;
}

export interface BenchShopServer {
  url: string;
  close: () => Promise<void>;
  /** All orders placed so far, in submission order. */
  getOrders: () => OrderRecord[];
}

const COUNTRIES = ["Germany", "France", "United Kingdom", "United States", "Other"];

interface Session {
  cart: Map<string, number>; // productId -> qty
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// Client-side script shared by every page. Plain ES5-ish syntax on purpose —
// this runs unbundled, straight from a <script> tag, in whatever engine
// Electron's WebContentsView happens to be running.
// Per-server-start consent token. The browser tab's partition persists on
// disk across launches (Electron's userData ignores a redirected HOME on
// macOS) and cookies are not port-scoped, so a fixed `consent=1` from an
// earlier run silently suppressed the banner in every later one — the
// bench's agents all reported "no cookie banner". A fresh token per server
// makes every run start unconsented.
let consentToken = "1";

const SHARED_SCRIPT = `
(function () {
  function overlayPresent() {
    return !!document.getElementById('cookie-overlay');
  }
  // Delegated (not per-element) so it still guards elements created later by
  // the results page's own client-side re-render.
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('.guarded-link') : null;
    if (link && overlayPresent()) { e.preventDefault(); }
  }, true);
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.classList && form.classList.contains('guarded-form') && overlayPresent()) {
      e.preventDefault();
    }
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    var acceptBtn = document.getElementById('accept-cookies');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        document.cookie = 'consent=' + (acceptBtn.getAttribute('data-consent-token') || '1') + '; path=/; max-age=31536000';
        var overlay = document.getElementById('cookie-overlay');
        if (overlay) overlay.remove();
      });
    }
    var addBtn = document.getElementById('add-to-cart');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        if (overlayPresent()) return;
        fetch('/api/cart/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ productId: addBtn.getAttribute('data-id') }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var status = document.getElementById('cart-status');
            if (status) {
              status.textContent = 'Added to cart (' + data.cartCount + ' item' + (data.cartCount === 1 ? '' : 's') + ')';
            }
            var goCart = document.getElementById('go-to-cart');
            if (goCart) goCart.style.display = 'inline';
          });
      });
    }
  });
})();
`;

function layout(opts: { title: string; body: string; consented: boolean; extraScript?: string }): string {
  const { title, body, consented, extraScript } = opts;
  const dropdownLinks = CATEGORIES.map(
    (c) => `<a class="guarded-link" href="/search?q=${encodeURIComponent(c)}">${escapeHtml(c)}</a>`,
  ).join("");
  const banner = consented
    ? ""
    : `<div id="cookie-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:flex-end;justify-content:center;">
        <div id="cookie-banner" style="background:#fff;padding:16px 24px;margin:24px;border-radius:8px;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,.25)">
          <p id="cookie-message">We use cookies to improve your shopping experience.</p>
          <button id="accept-cookies" type="button" data-consent-token="${consentToken}">Accept</button>
        </div>
      </div>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Bench Shop</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 0 16px 32px; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid #ddd; }
  .nav-item { position: relative; display: inline-block; padding: 8px; cursor: default; }
  .dropdown { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #ccc; padding: 8px; z-index: 10; min-width: 140px; }
  .dropdown a { display: block; padding: 4px 0; }
  .nav-item:hover .dropdown { display: block; }
  #results-list, #cart-list { list-style: none; padding: 0; }
  .result-item { padding: 8px 0; border-bottom: 1px solid #eee; }
  fieldset { border: 1px solid #ddd; margin-bottom: 8px; }
  label { display: block; margin: 4px 0; }
</style>
</head>
<body>
<header>
  <a href="/" class="logo guarded-link">Bench Shop</a>
  <nav id="main-nav">
    <div class="nav-item">
      <span>Categories</span>
      <div class="dropdown">${dropdownLinks}</div>
    </div>
  </nav>
  <form id="search-form" class="guarded-form" action="/search" method="get">
    <input type="text" name="q" id="search-input" placeholder="Search products" autocomplete="off" />
  </form>
</header>
<main>
${body}
</main>
${banner}
<script>${SHARED_SCRIPT}</script>
${extraScript ? `<script>${extraScript}</script>` : ""}
</body>
</html>`;
}

function productCard(p: Product): string {
  return `<li class="result-item" data-id="${p.id}" data-brand="${escapeHtml(p.brand)}" data-price="${p.price}" data-wireless="${p.wireless}" data-rating="${p.rating}">
    <a class="guarded-link result-link" href="/product/${p.id}">${escapeHtml(p.name)}</a>
    — $${p.price.toFixed(2)} — ${escapeHtml(p.brand)}${p.wireless ? " — Wireless" : ""} — Rating ${p.rating}
  </li>`;
}

function searchPage(q: string, consented: boolean): string {
  const matches = searchProducts(q);
  const brands = Array.from(new Set(matches.map((p) => p.brand))).sort();
  const body = `
<h1 id="results-heading">Search results for "${escapeHtml(q)}"</h1>
<div id="filters">
  <fieldset>
    <legend>Brand</legend>
    ${brands.map((b) => `<label><input type="checkbox" class="filter-brand" value="${escapeHtml(b)}" aria-label="${escapeHtml(b)}" /> ${escapeHtml(b)}</label>`).join("")}
  </fieldset>
  <label>Max price <input type="number" id="filter-price-max" min="0" step="1" placeholder="No limit" /></label>
  <label><input type="checkbox" id="filter-wireless" /> Wireless only</label>
  <label>Sort by
    <select id="sort-select">
      <option value="">Relevance</option>
      <option value="price-asc">Price: Low to High</option>
      <option value="price-desc">Price: High to Low</option>
      <option value="rating-desc">Rating</option>
    </select>
  </label>
</div>
<ul id="results-list">${matches.map(productCard).join("")}</ul>
<script id="results-data" type="application/json">${JSON.stringify(matches)}</script>`;
  const extraScript = `
(function () {
  var dataEl = document.getElementById('results-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  function render() {
    var brandChecks = Array.prototype.slice.call(document.querySelectorAll('.filter-brand:checked')).map(function (el) { return el.value; });
    var maxPriceRaw = document.getElementById('filter-price-max').value;
    var wirelessOnly = document.getElementById('filter-wireless').checked;
    var sort = document.getElementById('sort-select').value;
    var list = data.filter(function (p) {
      if (brandChecks.length && brandChecks.indexOf(p.brand) === -1) return false;
      if (maxPriceRaw !== '' && p.price > parseFloat(maxPriceRaw)) return false;
      if (wirelessOnly && !p.wireless) return false;
      return true;
    });
    if (sort === 'price-asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (sort === 'price-desc') list.sort(function (a, b) { return b.price - a.price; });
    else if (sort === 'rating-desc') list.sort(function (a, b) { return b.rating - a.rating; });
    var ul = document.getElementById('results-list');
    ul.innerHTML = list.length
      ? list.map(function (p) {
          return '<li class="result-item" data-id="' + p.id + '" data-brand="' + p.brand + '" data-price="' + p.price + '" data-wireless="' + p.wireless + '" data-rating="' + p.rating + '">' +
            '<a class="guarded-link result-link" href="/product/' + p.id + '">' + p.name + '</a>' +
            ' — $' + p.price.toFixed(2) + ' — ' + p.brand + (p.wireless ? ' — Wireless' : '') + ' — Rating ' + p.rating +
            '</li>';
        }).join('')
      : '<li id="no-results">No results match your filters.</li>';
  }
  document.querySelectorAll('.filter-brand').forEach(function (el) { el.addEventListener('change', render); });
  var priceEl = document.getElementById('filter-price-max');
  if (priceEl) priceEl.addEventListener('input', render);
  var wirelessEl = document.getElementById('filter-wireless');
  if (wirelessEl) wirelessEl.addEventListener('change', render);
  var sortEl = document.getElementById('sort-select');
  if (sortEl) sortEl.addEventListener('change', render);
})();`;
  return layout({ title: `Search: ${q}`, body, consented, extraScript });
}

function productPage(p: Product, consented: boolean): string {
  const body = `
<h1>${escapeHtml(p.name)}</h1>
<p>Brand: ${escapeHtml(p.brand)}</p>
<p id="product-price">Price: $${p.price.toFixed(2)}</p>
<p>${p.wireless ? "Wireless" : "Wired"} — Rating ${p.rating}</p>
<p>${escapeHtml(p.description)}</p>
<button id="add-to-cart" type="button" data-id="${p.id}">Add to Cart</button>
<p id="cart-status"></p>
<a id="go-to-cart" class="guarded-link" href="/cart" style="display:none">Go to Cart</a>`;
  return layout({ title: p.name, body, consented });
}

function cartPage(items: OrderItem[], consented: boolean): string {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const body = items.length
    ? `<h1>Your Cart</h1>
       <ul id="cart-list">${items.map((i) => `<li data-id="${i.productId}">${escapeHtml(i.name)} x${i.qty} — $${(i.price * i.qty).toFixed(2)}</li>`).join("")}</ul>
       <p id="cart-total">Total: $${total.toFixed(2)}</p>
       <a id="checkout-link" class="guarded-link" href="/checkout">Proceed to Checkout</a>`
    : `<h1>Your Cart</h1><p id="cart-empty">Your cart is empty.</p>`;
  return layout({ title: "Cart", body, consented });
}

interface CheckoutValues {
  fullName?: string;
  email?: string;
  country?: string;
  shipping?: string;
  terms?: boolean;
}

function checkoutPage(values: CheckoutValues, errors: string[], consented: boolean): string {
  const errorBlock = errors.length
    ? `<div id="checkout-errors"><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`
    : "";
  const body = `
<h1>Checkout</h1>
${errorBlock}
<form id="checkout-form" class="guarded-form" action="/checkout" method="post">
  <label>Full name <input type="text" name="fullName" id="checkout-name" value="${escapeHtml(values.fullName ?? "")}" /></label>
  <label>Email <input type="email" name="email" id="checkout-email" value="${escapeHtml(values.email ?? "")}" /></label>
  <label>Country
    <select name="country" id="checkout-country">
      <option value="">Select a country</option>
      ${COUNTRIES.map((c) => `<option value="${c}" ${values.country === c ? "selected" : ""}>${c}</option>`).join("")}
    </select>
  </label>
  <fieldset>
    <legend>Shipping</legend>
    <label><input type="radio" name="shipping" value="standard" id="shipping-standard" ${values.shipping === "standard" ? "checked" : ""} /> Standard Shipping (5-7 days)</label>
    <label><input type="radio" name="shipping" value="express" id="shipping-express" ${values.shipping === "express" ? "checked" : ""} /> Express Shipping (1-2 days)</label>
  </fieldset>
  <label><input type="checkbox" name="terms" id="checkout-terms" value="on" ${values.terms ? "checked" : ""} /> I accept the Terms and Conditions</label>
  <button id="checkout-submit" type="submit">Place Order</button>
</form>`;
  return layout({ title: "Checkout", body, consented });
}

function confirmPage(order: OrderRecord, consented: boolean): string {
  const body = `
<h1>Order Confirmed</h1>
<p id="order-number">Order Number: ${order.orderNumber}</p>
<p>Thank you, ${escapeHtml(order.fullName)}. A confirmation has been sent to ${escapeHtml(order.email)}.</p>
<ul>${order.items.map((i) => `<li>${escapeHtml(i.name)} x${i.qty}</li>`).join("")}</ul>
<p id="order-total">Total: $${order.total.toFixed(2)}</p>`;
  return layout({ title: "Order Confirmed", body, consented });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function startBenchShopServer(): Promise<BenchShopServer> {
  const sessions = new Map<string, Session>();
  const orders: OrderRecord[] = [];
  let orderCounter = 100000;

  function sessionFor(req: http.IncomingMessage, res: http.ServerResponse): { sid: string; session: Session } {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies.sid;
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomUUID();
      sessions.set(sid, { cart: new Map() });
      res.setHeader("Set-Cookie", [`sid=${sid}; Path=/`]);
    }
    return { sid, session: sessions.get(sid) as Session };
  }

  consentToken = crypto.randomUUID();
  function isConsented(req: http.IncomingMessage): boolean {
    return parseCookies(req.headers.cookie).consent === consentToken;
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const parsedUrl = new URL(req.url ?? "/", "http://bench-shop.local");
        const pathname = parsedUrl.pathname;
        const consented = isConsented(req);
        const { session } = sessionFor(req, res);

        if (req.method === "GET" && pathname === "/") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            layout({
              title: "Home",
              consented,
              body: `<h1 id="home-heading">Welcome to Bench Shop</h1><p>Search for products above, or browse Categories.</p>`,
            }),
          );
          return;
        }

        if (req.method === "GET" && pathname === "/search") {
          const q = parsedUrl.searchParams.get("q") ?? "";
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(searchPage(q, consented));
          return;
        }

        if (req.method === "GET" && pathname.startsWith("/product/")) {
          const id = pathname.slice("/product/".length);
          const product = findProduct(id);
          if (!product) {
            res.statusCode = 404;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(layout({ title: "Not Found", consented, body: `<h1>Product not found</h1>` }));
            return;
          }
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(productPage(product, consented));
          return;
        }

        if (req.method === "POST" && pathname === "/api/cart/add") {
          const body = await readBody(req);
          let productId = "";
          try {
            productId = (JSON.parse(body || "{}") as { productId?: string }).productId ?? "";
          } catch {
            // ignore malformed body, handled by the empty-productId check below
          }
          const product = findProduct(productId);
          if (!product) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Unknown productId" }));
            return;
          }
          session.cart.set(productId, (session.cart.get(productId) ?? 0) + 1);
          const cartCount = Array.from(session.cart.values()).reduce((a, b) => a + b, 0);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, cartCount }));
          return;
        }

        if (req.method === "GET" && pathname === "/cart") {
          const items: OrderItem[] = Array.from(session.cart.entries()).map(([productId, qty]) => {
            const product = findProduct(productId);
            return { productId, name: product?.name ?? productId, price: product?.price ?? 0, qty };
          });
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(cartPage(items, consented));
          return;
        }

        if (req.method === "GET" && pathname === "/checkout") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(checkoutPage({}, [], consented));
          return;
        }

        if (req.method === "POST" && pathname === "/checkout") {
          const raw = await readBody(req);
          const params = new URLSearchParams(raw);
          const fullName = (params.get("fullName") ?? "").trim();
          const email = (params.get("email") ?? "").trim();
          const country = (params.get("country") ?? "").trim();
          const shipping = (params.get("shipping") ?? "").trim();
          const terms = params.get("terms") === "on";

          const errors: string[] = [];
          if (!fullName) errors.push("Full name is required.");
          if (!email || !EMAIL_RE.test(email)) errors.push("A valid email address is required.");
          if (!country || !COUNTRIES.includes(country)) errors.push("Please select a country.");
          if (shipping !== "standard" && shipping !== "express") errors.push("Please choose a shipping method.");
          if (!terms) errors.push("You must accept the Terms and Conditions.");
          const items: OrderItem[] = Array.from(session.cart.entries()).map(([productId, qty]) => {
            const product = findProduct(productId);
            return { productId, name: product?.name ?? productId, price: product?.price ?? 0, qty };
          });
          if (items.length === 0) errors.push("Your cart is empty.");

          if (errors.length) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(checkoutPage({ fullName, email, country, shipping, terms }, errors, consented));
            return;
          }

          const orderNumber = `ORD-${(orderCounter++).toString()}`;
          const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
          const order: OrderRecord = {
            orderNumber,
            fullName,
            email,
            country,
            shipping: shipping as "standard" | "express",
            termsAccepted: true,
            items,
            total,
            createdAt: new Date().toISOString(),
          };
          orders.push(order);
          session.cart.clear();

          res.statusCode = 303;
          res.setHeader("Location", `/confirm?order=${encodeURIComponent(orderNumber)}`);
          res.end();
          return;
        }

        if (req.method === "GET" && pathname === "/confirm") {
          const orderNumber = parsedUrl.searchParams.get("order") ?? "";
          const order = orders.find((o) => o.orderNumber === orderNumber);
          if (!order) {
            res.statusCode = 404;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(layout({ title: "Not Found", consented, body: `<h1>Order not found</h1>` }));
            return;
          }
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(confirmPage(order, consented));
          return;
        }

        if (req.method === "GET" && pathname === "/api/orders") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(orders));
          return;
        }

        if (req.method === "GET" && pathname === "/api/products") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(PRODUCTS));
          return;
        }

        res.statusCode = 404;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(layout({ title: "Not Found", consented, body: `<h1>Not Found</h1>` }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    getOrders: () => orders.slice(),
  };
}
