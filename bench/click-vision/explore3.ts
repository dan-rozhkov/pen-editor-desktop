import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, launch, newPage, snapshot } from "./lib.ts";
const b = await launch(); const page = await newPage(b);
const sc: any = await import(pathToFileURL(path.join(ROOT,"bench/browse-task/src/scenarios.ts")).href);
async function dump(tag: string) { const s = await snapshot(page); console.log(`\n== ${tag} ${s.url} (${s.elements.length})\nTEXT: ${s.text.replace(/\n/g," | ").slice(0,700)}`);
  console.log(s.elements.map(e=>`${e.index} ${e.tag}${e.role?"/"+e.role:""} "${(e.label||"").slice(0,50)}" ${e.ops.join("")}${e.value?" v="+e.value:""}`).join("\n")); }
let run = await sc.SCENARIOS.find((s:any)=>s.id==="lookup").start();
await page.goto(run.url+"/search?q=silent+orchard"); await dump("lookup results"); await run.close();
run = await sc.SCENARIOS.find((s:any)=>s.id==="booking").start();
await page.goto(run.url); await page.click("button:has-text('Accept all')"); await page.waitForTimeout(400); await dump("booking main");
await page.getByRole("combobox",{name:"Destination"}).click(); await page.keyboard.type("lis",{delay:40}); await page.waitForTimeout(900); await dump("booking autocomplete");
await page.keyboard.press("Escape"); await page.click("text=Standard room ▾"); await page.waitForTimeout(300); await dump("booking roomdd");
await run.close(); await b.close();
