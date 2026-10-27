import "dotenv/config";
import Steel from "steel-sdk";
const s = new Steel({ steelAPIKey: process.env.STEEL_API_KEY! });
const r: any = await s.sessions.list();
const items = r.sessions ?? r.items ?? r;
let n = 0;
for (const x of items) { if (x.status === "live") { n++; console.log("releasing", x.id); await s.sessions.release(x.id); } }
console.log("live leftovers released:", n, "total listed", items.length);
