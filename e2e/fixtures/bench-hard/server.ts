// A tiny, dependency-free HTTP server serving ten single-purpose fixture
// pages used by e2e/bench-actions.spec.ts's Part B (reliability). Modeled on
// e2e/fixtures/bench-shop/server.ts — plain Node `http`, no build step, no
// client framework — but each page here exercises exactly one interaction
// shape (shadow DOM, a same-origin iframe, a pointerdown-only menu, a
// trusted-input-only handler, an inner scroll container, a React-style
// controlled input, an async network result, a delayed render, a
// second-nested iframe, and a native <select>) so a single failing case
// pins down a single bridge limitation rather than a tangle of them.
//
// Every page exposes its success flag as visible top-document text (an
// element with id="result", or the page title) so a test can read it back
// through window.penDesktop.browser.read() — never by reaching into the page
// via Playwright directly, since the whole point is to exercise the bridge.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface BenchHardServer {
  url: string;
  close: () => Promise<void>;
}

function page(body: string, opts: { title?: string } = {}): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>${opts.title ?? "Bench Hard"}</title></head>
<body style="font-family:sans-serif;margin:16px;">
${body}
</body>
</html>`;
}

const OVERHEAD_CLICK_BUTTONS = Array.from({ length: 10 }, (_, i) => i)
  .map(
    (i) =>
      `<button id="click-btn-${i}" type="button" onclick="this.textContent='clicked-${i}'">Click ${i}</button>`,
  )
  .join("\n      ");

const PAGES: Record<string, string> = {
  // Used by e2e/bench-actions.spec.ts's fixed-overhead sequence: 10 non-
  // navigating clicks (each just relabels itself, no state shared across
  // clicks) and 10 `act press` (default target is a focusable input).
  "/overhead-bench": page(`
    <h1>Overhead Bench</h1>
    <input id="focus-input" aria-label="Focus Input" />
    ${OVERHEAD_CLICK_BUTTONS}
  `),

  "/shadow-dom": page(`
    <h1>Shadow DOM</h1>
    <div id="result">pending</div>
    <pen-shadow-widget></pen-shadow-widget>
    <script>
      class PenShadowWidget extends HTMLElement {
        connectedCallback() {
          var root = this.attachShadow({ mode: "open" });
          root.innerHTML = '<button id="shadow-buy">Shadow Buy</button>';
          root.getElementById("shadow-buy").addEventListener("click", function () {
            document.getElementById("result").textContent = "OK";
          });
        }
      }
      customElements.define("pen-shadow-widget", PenShadowWidget);
    </script>
  `),

  "/iframe-same-origin": page(`
    <h1>Iframe Buy</h1>
    <div id="result">pending</div>
    <iframe id="shop-frame" src="/iframe-inner" style="width:400px;height:160px;border:1px solid #ccc"></iframe>
    <script>
      window.addEventListener("message", function (e) {
        if (e.data === "frame-buy-clicked") {
          document.getElementById("result").textContent = "OK";
        }
      });
    </script>
  `),
  "/iframe-inner": page(`
    <button id="frame-buy">Frame Buy</button>
    <script>
      document.getElementById("frame-buy").addEventListener("click", function () {
        parent.postMessage("frame-buy-clicked", "*");
      });
    </script>
  `),

  "/pointerdown-menu": page(`
    <h1>Pointerdown Menu</h1>
    <div id="result">pending</div>
    <button id="menu-trigger">Open Menu</button>
    <div id="menu" hidden>
      <button id="menu-item">Menu Item</button>
    </div>
    <script>
      document.getElementById("menu-trigger").addEventListener("pointerdown", function () {
        document.getElementById("menu").hidden = false;
      });
      // Only counts when the menu was genuinely opened first — a bridge that
      // clicks the hidden item directly must not score a pass.
      document.getElementById("menu-item").addEventListener("click", function () {
        if (!document.getElementById("menu").hidden) {
          document.getElementById("result").textContent = "OK";
        }
      });
    </script>
  `),

  "/trusted-click": page(`
    <h1>Trusted Click</h1>
    <div id="result">pending</div>
    <button id="trusted-buy">Trusted Buy</button>
    <script>
      document.getElementById("trusted-buy").addEventListener("click", function (e) {
        if (e.isTrusted) {
          document.getElementById("result").textContent = "OK";
        }
      });
    </script>
  `),

  "/inner-scroll": page(`
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      #page-wrap { padding: 16px; }
      #scroller { height: 260px; width: 280px; overflow: auto; border: 1px solid #ccc; }
      .row { height: 36px; line-height: 36px; padding: 0 8px; border-bottom: 1px solid #eee; }
    </style>
    <div id="page-wrap">
      <h1>Inner Scroll</h1>
      <div id="result">pending</div>
      <div id="scroller"></div>
    </div>
    <script>
      var rows = "";
      for (var i = 1; i <= 60; i++) {
        if (i === 55) rows += '<div class="row"><button id="row-55-btn">Row 55</button></div>';
        else rows += '<div class="row">Row ' + i + '</div>';
      }
      document.getElementById("scroller").innerHTML = rows;
      document.getElementById("row-55-btn").addEventListener("click", function () {
        document.getElementById("result").textContent = "OK";
      });
    </script>
  `),

  "/react-like-input": page(`
    <h1>React-like Input</h1>
    <div id="result">pending</div>
    <div id="key-count">0</div>
    <input id="name-input" placeholder="Name Input" aria-label="Name Input" autocomplete="off" />
    <script>
      var count = 0;
      var input = document.getElementById("name-input");
      input.addEventListener("keydown", function () {
        count++;
        document.getElementById("key-count").textContent = "keydowns:" + String(count);
      });
      input.addEventListener("input", function (e) {
        document.getElementById("result").textContent = e.target.value;
      });
    </script>
  `),

  "/slow-network-result": page(`
    <h1>Slow Network Result</h1>
    <div id="result">idle</div>
    <button id="load-btn">Load</button>
    <script>
      document.getElementById("load-btn").addEventListener("click", function () {
        document.getElementById("result").textContent = "Loading...";
        fetch("/slow-data")
          .then(function (r) { return r.text(); })
          .then(function (t) { document.getElementById("result").textContent = t; });
      });
    </script>
  `),

  "/spinner-then-button": page(`
    <h1>Spinner Then Button</h1>
    <div id="result">pending</div>
    <div id="spinner">Loading…</div>
    <div id="late-container"></div>
    <script>
      setTimeout(function () {
        var spinner = document.getElementById("spinner");
        if (spinner) spinner.remove();
        var btn = document.createElement("button");
        btn.id = "late-buy";
        btn.textContent = "Late Buy";
        btn.addEventListener("click", function () {
          document.getElementById("result").textContent = "OK";
        });
        document.getElementById("late-container").appendChild(btn);
      }, 1500);
    </script>
  `),

  "/cookie-banner-iframe": page(`
    <h1>Cookie Banner (iframe)</h1>
    <div id="result">pending</div>
    <iframe id="consent-frame" src="/cookie-consent-inner" style="width:400px;height:150px;border:1px solid #ccc"></iframe>
    <script>
      window.addEventListener("message", function (e) {
        if (e.data === "consent-accepted") {
          var f = document.getElementById("consent-frame");
          if (f) f.remove();
          document.getElementById("result").textContent = "consent ok";
        }
      });
    </script>
  `),
  "/cookie-consent-inner": page(`
    <button id="accept-all">Accept all</button>
    <script>
      document.getElementById("accept-all").addEventListener("click", function () {
        parent.postMessage("consent-accepted", "*");
      });
    </script>
  `),

  "/native-select": page(`
    <h1>Native Select</h1>
    <div id="result">pending</div>
    <label>Country
      <select id="country-select" aria-label="Country">
        <option value="">Select a country</option>
        <option value="US">United States</option>
        <option value="DE">Germany</option>
        <option value="FR">France</option>
      </select>
    </label>
    <script>
      document.getElementById("country-select").addEventListener("change", function (e) {
        var opt = e.target.options[e.target.selectedIndex];
        if (opt && opt.textContent === "Germany") {
          document.getElementById("result").textContent = "OK";
        }
      });
    </script>
  `),
};

const SLOW_DATA_DELAY_MS = 1200;

export async function startBenchHardServer(): Promise<BenchHardServer> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://bench-hard.local").pathname;

    if (pathname === "/slow-data") {
      setTimeout(() => {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Loaded 42");
      }, SLOW_DATA_DELAY_MS);
      return;
    }

    const body = PAGES[pathname];
    if (body === undefined) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(page(`<h1>Not Found</h1><p>${pathname}</p>`));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
