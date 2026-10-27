import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, DATA, HERE, GRID, launch, newPage, snapshot, marks, unmarks, rects, startStatic } from "./lib.ts";
import { PAGES } from "./pages.ts";
import { ITEMS } from "./items.ts";

const sc: any = await import(pathToFileURL(path.join(ROOT, "bench/browse-task/src/scenarios.ts")).href);
const b = await launch(); const page = await newPage(b);
const stat = await startStatic(PAGES);
const closers: Array<() => Promise<void>> = [stat.close];
const urls: Record<string, string> = {};
for (const id of ["shop", "lookup", "booking", "form"]) { const r = await sc.SCENARIOS.find((s: any) => s.id === id).start(); urls[id] = r.url; closers.push(r.close); }

async function enter(state: string) {
  if (state.startsWith("/")) { await page.goto(stat.url + state); await page.waitForTimeout(250); return; }
  if (state === "shop:home") { await page.context().clearCookies(); await page.goto(urls.shop); await page.evaluate(()=>{try{localStorage.clear();sessionStorage.clear()}catch{}}); await page.reload(); }
  else if (state === "shop:results") { await page.goto(urls.shop); await page.click("button:has-text('Accept')",{timeout:1500}).catch(()=>{}); await page.waitForTimeout(300); await page.goto(urls.shop + "/search?q=headphones"); }
  else if (state === "lookup:results") { await page.goto(urls.lookup + "/search?q=silent+orchard"); }
  else if (state === "booking:cookie") { await page.goto(urls.booking); }
  else if (state === "booking:main") { await page.goto(urls.booking); await page.click("button:has-text('Accept all')",{timeout:1500}).catch(()=>{}); }
  else if (state === "booking:auto") { await page.goto(urls.booking); await page.click("button:has-text('Accept all')",{timeout:1500}).catch(()=>{}); await page.getByRole("combobox", { name: "Destination" }).click(); await page.keyboard.type("lis", { delay: 40 }); await page.waitForTimeout(700); }
  else if (state === "form:main") { await page.goto(urls.form + "/register"); }
  else throw new Error("state " + state);
  await page.waitForTimeout(500);
}
async function gridOn() {
  await page.evaluate((g) => {
    const c = document.createElement("div"); c.setAttribute("data-pen-grid", "1");
    c.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none";
    for (let r = 0; r < g.rows; r++) for (let k = 0; k < g.cols; k++) {
      const d = document.createElement("div");
      d.style.cssText = `position:fixed;left:${k * g.cw}px;top:${r * g.ch}px;width:${g.cw}px;height:${g.ch}px;box-sizing:border-box;border:1px solid rgba(255,0,200,.55);font:10px monospace;color:#c0008f;padding:1px 2px`;
      d.textContent = String.fromCharCode(65 + k) + (r + 1); c.appendChild(d);
    }
    document.documentElement.appendChild(c);
  }, GRID);
}
const out = DATA; fs.mkdirSync(path.join(out, "shots"), { recursive: true });
const prepared: any[] = [];
for (const it of ITEMS) {
  await enter(it.state);
  const snap = await snapshot(page);
  // ground truth
  await page.locator(it.sel).first().evaluate((el) => el.setAttribute("data-gt", "1"));
  const target = await page.evaluate((id) => {
    const el = document.querySelector("[data-gt]")!; const s = el.closest(`[data-pen-snap^="${id}:"]`) || el.querySelector(`[data-pen-snap^="${id}:"]`);
    if (!s) return null; return parseInt(s.getAttribute("data-pen-snap")!.slice(id.length + 1), 10);
  }, snap.id);
  const rc = await rects(page, snap.id);
  await page.screenshot({ path: path.join(out, "shots", `${it.id}.plain.jpg`), type: "jpeg", quality: 70 });
  await marks(page, snap.id);
  await page.screenshot({ path: path.join(out, "shots", `${it.id}.marked.jpg`), type: "jpeg", quality: 70 });
  await unmarks(page);
  await gridOn();
  await page.screenshot({ path: path.join(out, "shots", `${it.id}.grid.jpg`), type: "jpeg", quality: 70 });
  const clickable = snap.elements.filter((e: any) => e.ops?.includes("CLICK")).length;
  console.log(it.id.padEnd(18), "target", target, "elements", snap.elements.length, "clickable", clickable, target === null ? "  <-- TARGET NOT IN SNAPSHOT" : "");
  prepared.push({ ...it, target, snap, rects: rc });
}
fs.writeFileSync(path.join(out, "prepared.json"), JSON.stringify(prepared, null, 1));
await b.close(); for (const c of closers) await c();
