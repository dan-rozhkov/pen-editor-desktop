// A sign-in page that emulates a late-hydrating SPA (Next.js-like CRM on a slow
// dev server). `/login?hydrateMs=1500&mode=keep|reset`:
//  - the form is in the HTML at once, but until hydration its submit does
//    nothing (inline preventDefault);
//  - at `hydrateMs` the "app" starts with state {email:"", password:""}, which
//    only `input` events fired AFTER hydration can fill;
//  - mode=keep: the DOM values stay as typed (React controlled input whose state
//    is still empty); mode=reset: hydration clears both fields;
//  - after hydration a submit with empty state returns silently (no error text);
//    otherwise it POSTs /api/login and navigates to /dashboard, or shows
//    "Invalid email or password" and stays.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const HYDRATION_USER = "qa@example.test";
export const HYDRATION_PASSWORD = "e2e-Hydration-Pw-1";

const loginPage = (hydrateMs: number, mode: string): string => `<!doctype html><title>Sign in</title>
<h1>Sign in</h1>
<form id="f" method="get" action="/login" onsubmit="if(!window.__hydrated){event.preventDefault();}">
  <input id="email" type="text" name="email" aria-label="Email">
  <input id="pw" type="password" name="password" aria-label="Password">
  <button id="go" type="submit">Sign in</button>
</form>
<p id="err" role="alert"></p>
<script>
setTimeout(function () {
  var state = { email: "", password: "" };
  var email = document.getElementById("email");
  var pw = document.getElementById("pw");
  if (${JSON.stringify(mode)} === "reset") { email.value = ""; pw.value = ""; }
  email.addEventListener("input", function () { state.email = email.value; });
  pw.addEventListener("input", function () { state.password = pw.value; });
  document.getElementById("f").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!state.email || !state.password) return;
    fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state) })
      .then(function (r) {
        if (r.ok) location.href = "/dashboard";
        else document.getElementById("err").textContent = "Invalid email or password";
      });
  });
  window.__hydrated = true;
}, ${Math.max(0, Math.floor(hydrateMs))});
</script>`;

export interface HydrationLoginServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startHydrationLoginServer(): Promise<HydrationLoginServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let ok = false;
        try {
          const j = JSON.parse(body) as { email?: string; password?: string };
          ok = j.email === HYDRATION_USER && j.password === HYDRATION_PASSWORD;
        } catch {
          ok = false;
        }
        res.statusCode = ok ? 200 : 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/login") {
      const hydrateMs = Number(url.searchParams.get("hydrateMs") ?? "0");
      res.end(loginPage(Number.isFinite(hydrateMs) ? hydrateMs : 0, url.searchParams.get("mode") === "reset" ? "reset" : "keep"));
      return;
    }
    if (url.pathname === "/dashboard") {
      res.end(`<!doctype html><title>Dashboard</title><h1 id="ws">QA Workspace</h1>`);
      return;
    }
    res.end(`<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
