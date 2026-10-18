// Scratch live QA scenario: real LLM, built Electron shell, deployed prod
// frontend+backend. Local fixture site returns 500 on signup. Run with
// `npx playwright test --config playwright.live.config.ts e2e/live-qa-diagnostics.spec.ts`.
import { test, expect, type Page } from "@playwright/test";
import { launchShell } from "./launch";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";

const PROD_EDITOR = process.env.PEN_LIVE_URL ?? "https://pen-editor.onrender.com/app";
const editorOrigin = new URL(PROD_EDITOR).origin;

const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signup</title></head>
<body><h1>Sign up</h1>
<form id="f"><label>Name <input name="name" id="name" type="text"></label><br>
<label>Email <input name="email" id="email" type="email"></label><br>
<label>Avatar <input name="avatar" id="avatar" type="file" accept="image/*"></label><br>
<button type="submit">Submit</button></form>
<p id="file">No file chosen</p><p id="vw">innerWidth: <span id="w"></span></p><p id="msg"></p>
<script>
document.getElementById('w').textContent = window.innerWidth;
document.getElementById('avatar').addEventListener('change', e => {
  const f = e.target.files[0]; document.getElementById('file').textContent = f ? 'Uploaded file: ' + f.name + ' (' + f.size + ' bytes)' : 'No file chosen';
});
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await fetch('/api/signup', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name.value, email: email.value})});
  if (!r.ok) { document.getElementById('msg').textContent = 'Something went wrong'; console.error('signup failed'); }
  else document.getElementById('msg').textContent = 'Welcome';
});
</script></body></html>`;

type Rec = { method: string; url: string; ua: string };

test.setTimeout(240_000);
test("live: QA mode diagnostics against a failing signup form", async ({}, testInfo) => {
  const served: Rec[] = [];
  const server = http.createServer((req, res) => {
    served.push({ method: req.method ?? "", url: req.url ?? "", ua: String(req.headers["user-agent"] ?? "") });
    if (req.url === "/form") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(FORM_HTML);
    } else if (req.url === "/api/signup") {
      req.resume();
      res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"boom"}');
    } else res.writeHead(404).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const home = testInfo.outputPath("home");
  const app = await launchShell({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: PROD_EDITOR, HOME: home, USERPROFILE: home },
  });
  const proc = app.process();
  proc.stdout?.on("data", (d) => console.log("APP OUT " + String(d).slice(0, 800)));
  proc.stderr?.on("data", (d) => console.log("APP ERR " + String(d).slice(0, 800)));
  proc.on("exit", (c, sig) => console.log("APP EXIT " + c + " " + sig));
  const allPages: Page[] = [];
  const chatBodies: { t: number; body: string }[] = [];
  const pageErrors: string[] = [];
  const attach = (page: Page) => {
    allPages.push(page);
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("close", () => console.log("PAGE CLOSED " + page.url()));
    page.on("response", (r) => { if (new URL(r.url()).pathname.endsWith("/api/chat")) console.log("CHAT RESPONSE " + r.status() + " " + r.url()); });
    page.on("requestfailed", (r) => { if (new URL(r.url()).pathname.endsWith("/api/chat")) console.log("CHAT FAILED " + r.failure()?.errorText); });
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/api/chat")) {
        chatBodies.push({ t: Date.now(), body: r.postData() ?? "" });
      }
    });
  };
  app.windows().forEach(attach);
  app.on("window", attach);

  const NOEMU = !!process.env.QA_NOEMU;
  const attempts0 = [
    `Use browse_agent with qa: true to test ${base}/form (desktop viewport, no device emulation, no setup). Fill name and email, upload a sample PNG as the avatar (browse_act upload), submit, and check that the text 'Welcome' appears. Use final checks: no failed requests, text 'Welcome' visible.`,
    `Call the browse_agent tool NOW with exact arguments: qa: true, url "${base}/form", goal: "Fill the name and email inputs, upload a sample PNG (files: [{name:'avatar.png', sample:'png'}]) in the avatar file input via browse_act action upload, click Submit, then verify the text 'Welcome' appears.", final checks: [no failed requests, text 'Welcome' visible]. Use qa_assert for checks. Do not ask questions; report the verdict.`,
  ];
  const attempts = process.env.QA_PROBE ? [process.env.QA_PROBE.replace("BASE", base)] : NOEMU ? attempts0 : [
    `Use browse_agent with qa: true to test ${base}/form on an iPhone 15 (setup.emulate device iphone-15). Fill name and email, upload a sample PNG as the avatar, submit, and check that the text 'Welcome' appears. Use final checks: no failed requests, text 'Welcome' visible.`,
    `Call the browse_agent tool NOW with these exact arguments: qa: true, url "${base}/form", setup: { emulate: { device: "iphone-15" } }, goal: "Fill the name and email inputs, upload a small PNG file in the avatar file input (browse_act action upload), click Submit, then verify that the text 'Welcome' appears.", and final checks: [no failed requests, text 'Welcome' visible]. You may use qa_assert for checks. Do not ask me questions; report the verdict.`,
  ];

  type Found = { qa?: any; raw: string; calls: any[] } | null;
  const findResult = (): Found => {
    // The latest /api/chat body holds the full history incl. tool results.
    for (let i = chatBodies.length - 1; i >= 0; i--) {
      let j: any;
      try { j = JSON.parse(chatBodies[i].body); } catch { continue; }
      const calls: any[] = [];
      let found: any = null;
      for (const m of j.messages ?? []) for (const p of m.parts ?? []) {
        if (p.type === "tool-browse_agent" || (p.type === "dynamic-tool" && p.toolName === "browse_agent")) {
          calls.push(p);
          if (p.output !== undefined) found = p;
        }
      }
      if (found) {
        const raw = typeof found.output === "string" ? found.output : JSON.stringify(found.output);
        let qa; try { qa = (JSON.parse(raw)).qa; } catch { /* keep raw */ }
        return { qa, raw, calls };
      }
    }
    return null;
  };

  let found: Found = null;
  const t0 = Date.now();
  let usedAttempt = 0;
  try {
    // The chat lives in the agent panel (the /agent view); the canvas tab (app.canvasPage) is chatless.
    const panelPages = () => allPages.filter((p) => p.url().startsWith(`${editorOrigin}/agent`));
    await expect.poll(() => panelPages().length, { timeout: 60_000 }).toBeGreaterThan(0);
    const editor = panelPages()[0];
    editor.on("console", (m) => { if (m.text().startsWith("SSE ")) console.log(m.text().slice(0, 1500)); });
    await editor.evaluate(() => {
      const orig = window.fetch;
      window.fetch = async (...a: Parameters<typeof fetch>) => {
        const res = await orig(...a);
        const u = String(a[0] instanceof Request ? a[0].url : a[0]);
        if (u.includes("/api/chat") && res.body) {
          const [x, y] = res.body.tee();
          (async () => { const r = x.getReader(); const d = new TextDecoder(); for (;;) { const { done, value } = await r.read(); if (done) break; const t = d.decode(value); for (const m of t.matchAll(/"inputTextDelta":"((?:[^"\\]|\\.)*)"/g)) console.log("SSE " + m[1]); } })();
          return new Response(y, { status: res.status, headers: res.headers });
        }
        return res;
      };
    });
    if (process.env.QA_PRIME) {
      const r = await editor.evaluate(async (u) => (window as any).penAgentPanel.browser.open({ url: u }), base + "/form");
      console.log("PRIMED " + JSON.stringify(r).slice(0, 200));
    }
    // Panel state: chat list or an open chat (see bench-agent-layout-screens.spec.ts).
    await editor.getByPlaceholder("Ask the design agent...").or(editor.getByTestId("chat-list-new")).first().waitFor({ state: "visible", timeout: 90_000 });
    if (!(await editor.getByPlaceholder("Ask the design agent...").isVisible().catch(() => false))) await editor.getByTestId("chat-list-new").click();

    for (let a = 0; a < attempts.length && !found; a++) {
      usedAttempt = a + 1;
      const input = editor.getByPlaceholder("Ask the design agent...");
      await input.fill(attempts[a]);
      await input.press("Enter");
      const deadline = Date.now() + 80_000; let lastLog = 0;
      while (Date.now() < deadline) {
        found = findResult();
        if (found?.qa) break;
        if (Date.now() - lastLog > 20_000) {
          lastLog = Date.now();
          let sum = "";
          try { const j = JSON.parse(chatBodies.at(-1)?.body ?? "{}"); sum = (j.messages ?? []).slice(-3).map((m: any) => m.role + ":" + (m.parts ?? []).map((p: any) => p.type + (p.state ? "/" + p.state : "")).join(",")).join(" | "); } catch { /* */ }
          try { console.log("PANEL: " + (await editor.locator("body").innerText()).replace(/\s+/g, " ").slice(-700)); } catch (e) { console.log("panel read failed " + e); }
          console.log(`[${Math.round((Date.now() - t0) / 1000)}s] chatReqs=${chatBodies.length} last=${sum}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (found && !found.qa) found = null;
      // let the continuation settle
      if (found) await new Promise((r) => setTimeout(r, 15_000));
      else console.log(`attempt ${a + 1}: no browse_agent QA result; calls seen=${findResult()?.calls.length ?? 0}`);
    }
    const final = findResult();
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const out = { elapsedSec: elapsed, attempt: usedAttempt, base, qa: final?.qa, raw: final?.raw?.slice(0, 6000), served, pageErrors,
      chatRequestCount: chatBodies.length };
    writeFileSync(testInfo.outputPath("result.json"), JSON.stringify({ ...out, calls: final?.calls }, null, 1));
    console.log("RESULT_JSON " + JSON.stringify(out, null, 1));
    console.log("RESULT_PATH " + testInfo.outputPath("result.json"));

    // Nested requests capability check.
    const caps = chatBodies.map((b) => { try { return JSON.parse(b.body).clientCapabilities; } catch { return undefined; } });
    console.log("CAPS " + JSON.stringify(caps.map((c) => c?.browseAssert)));
    const steps: any[] = final?.qa?.steps ?? [];
    console.log("QA_ASSERT_CALLED " + JSON.stringify(
      JSON.stringify(final ?? {}).includes("qa_assert") || JSON.stringify(steps).includes("qa_assert")));

    expect(final?.qa, "browse_agent result has qa").toBeTruthy();
    expect(final?.qa?.outcome, "outcome").toBe("failed");
    expect(JSON.stringify(final?.qa?.failedRequests)).toContain("POST 500");
    expect(JSON.stringify(final?.qa?.failedRequests)).toContain("/api/signup");
    expect(JSON.stringify(final?.qa?.consoleErrors)).toContain("signup failed");
    const checks: any[] = final?.qa?.checks ?? [];
    expect(checks.some((c) => c.source === "final" && c.passed === false), "final check with passed false").toBe(true);
    expect(checks.some((c) => c.source === "final"), "final checks present").toBe(true);
    expect(JSON.stringify(steps), "upload step present").toMatch(/upload/);
    if (!NOEMU) expect(served.some((s) => s.url === "/form" && /iPhone/i.test(s.ua)), "iPhone UA on /form").toBe(true);
    expect(caps.filter((c) => c?.browseAssert === true).length, "requests with browseAssert").toBeGreaterThan(0);
    expect(caps.length > 0 && caps.every((c) => c?.browseAssert === true), "all requests browseAssert").toBe(true);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
});
