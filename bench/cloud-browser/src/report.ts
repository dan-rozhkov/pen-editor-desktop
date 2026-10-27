import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync(process.argv[2] + "/results.json", "utf8"));
console.log(j.target, JSON.stringify(j.coldStartMs), "fatal:", j.fatal?.slice(0, 300), "image:", j.image);
for (const s of j.sites ?? []) {
  const st = s.steps;
  const f = (k: string) => (st[k] ? `${st[k].clientMs ?? "-"}/${st[k].serverMs ?? "-"}${st[k].ok ? "" : "!"}` : "-");
  console.log(s.site.padEnd(10), "wall=" + s.wall, `(${s.wallMatch})`, "open", f("open"), "snap1", f("snapshot1"), "act", f("act"), "snap2", f("snapshot2"), "shot", f("screenshot"), "els", s.elements1raw+"->"+s.elements1, s.elements2, "|", s.actDesc, "|", (s.finalTitle ?? "").slice(0, 40), "|", s.errors.join("; ").slice(0, 200));
}
