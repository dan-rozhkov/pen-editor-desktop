import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, launch, newPage, snapshot } from "./lib.ts";
const b = await launch(); const page = await newPage(b);
const sc: any = await import(pathToFileURL(path.join(ROOT,"bench/browse-task/src/scenarios.ts")).href);
async function dump(tag: string) { const s = await snapshot(page); console.log(`\n== ${tag} ${s.url} (${s.elements.length})`);
  console.log(s.elements.map(e=>`${e.index} ${e.tag}${e.role?"/"+e.role:""} "${(e.label||"").slice(0,50)}" ${e.ops.join("")}${e.value?" v="+e.value:""}`).join("\n")); }
for (const id of ["shop","lookup","form","booking"]) {
  const sce = sc.SCENARIOS.find((s:any)=>s.id===id); const run = await sce.start();
  const start = id==="form"? run.url+"/register" : run.url;
  await page.goto(start); await page.waitForTimeout(600); await dump(id+" start");
  if (id==="shop") { await page.click("text=Accept"); await page.waitForTimeout(300); await dump("shop after cookies");
    await page.fill("input[type=search], input[name=q]", "headphones").catch(()=>{}); await page.keyboard.press("Enter"); await page.waitForTimeout(800); await dump("shop results"); }
  if (id==="lookup") { await page.goto(run.url+"/search?q=silent+orchard"); await page.waitForTimeout(400); await dump("lookup results"); }
  if (id==="booking") { await page.keyboard.press("Escape"); const t = await page.$("input[type=text],input:not([type])"); if(t){await t.click(); await t.type("lis",{delay:30}); await page.waitForTimeout(800); await dump("booking autocomplete");} }
  await run.close();
}
await b.close();
