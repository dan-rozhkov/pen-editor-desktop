import { readFileSync, readdirSync } from "node:fs";
const p50 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const t of ["local", "daytona"]) {
  const dirs = readdirSync("results").filter((d) => d.startsWith(t));
  const client: number[] = [], server: number[] = [], over: number[] = [], cs: Record<string, number[]> = {};
  const hl: number[] = [];
  for (const d of dirs) {
    const j = JSON.parse(readFileSync(`results/${d}/results.json`, "utf8"));
    hl.push(...(j.healthRttMs ?? []));
    for (const s of j.sites ?? []) {
      if (t === "daytona" && s.site !== "github") continue; // only reachable site
      for (const [k, v] of Object.entries<any>(s.steps)) if (v.ok && v.clientMs != null) { client.push(v.clientMs); server.push(v.serverMs); over.push(v.clientMs - v.serverMs); (cs[k] ??= []).push(v.clientMs); }
    }
    console.log(d, JSON.stringify(j.coldStartMs));
  }
  console.log(t, "n", client.length, "p50 client", p50(client), "p50 server", p50(server), "p50 overhead", p50(over), "health p50", p50(hl));
  console.log(" per-step p50 client:", Object.entries(cs).map(([k, v]) => `${k}=${p50(v)}`).join(" "));
}
