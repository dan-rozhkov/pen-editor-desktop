import { launch, newPage, snapshot, startStatic } from "./lib.ts";
import { PAGES } from "./pages.ts";
const b = await launch(); const page = await newPage(b); const srv = await startStatic(PAGES);
for (const p of Object.keys(PAGES)) { await page.goto(srv.url + p); await page.waitForTimeout(200); const s = await snapshot(page);
 console.log(`\n== ${p} (${s.elements.length})\n` + s.elements.map(e=>`${e.index} ${e.tag}${e.role?"/"+e.role:""} "${(e.label||"").slice(0,50)}" ${e.ops.join("")}${e.disabled?" DIS":""}`).join("\n")); }
await b.close(); await srv.close();
