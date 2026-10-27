// usage: npm run cost -- results/<dir> [results/<dir2> ...]
// Cost per run from the bench's backend log: chat tokens with the prompt-cache
// split ("[tokens] ... cache read"), Luna/Jev decision tokens (browse steps and
// skill routing), and an ESTIMATE for the gemini plan/text calls (their tokens
// are not logged). Prices: OpenRouter /api/v1/models (deepseek-v4.1-flash,
// gemini-2.5-flash) and a live /systemone response for gpt-6-luna-decisions
// (usage.cost = $0.10 per 1M input tokens, 0 output), checked 2026-10-13.
import fs from "node:fs";
import path from "node:path";

const PRICE = {
  chatIn: 0.0441e-6,
  chatCacheRead: 0.0054e-6,
  chatOut: 0.63e-6,
  decisionIn: 0.1e-6,
  geminiPlanCall: 2000 * 0.3e-6 + 300 * 2.5e-6,
  geminiTextCall: 2000 * 0.3e-6 + 50 * 2.5e-6,
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: npm run cost -- results/<dir> [results/<dir2> ...]");
  process.exit(1);
}

const usd = (x: number) => `$${x.toFixed(4)}`;

console.log("| dir | runs | chat in/run | cache read | chat | routing | steps | gemini (est.) | total/run |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const dir of dirs) {
  const logs = fs.readdirSync(dir).filter((f) => f.startsWith("backend") && f.endsWith(".log"));
  const runs = fs.readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)).length;
  if (runs === 0 || logs.length === 0) {
    console.log(`| ${path.basename(dir)} | 0 | no runs or no backend log | | | | | | |`);
    continue;
  }
  let chatIn = 0, chatOut = 0, cacheRead = 0, routeTok = 0, stepTok = 0, plans = 0, texts = 0;
  // routeSkill memoizes its verdict per user message, and a cache hit is logged
  // with the ORIGINAL call's inputTokens/pass1Ms. Count each distinct line once,
  // or every tool-loop continuation re-counts the same call.
  const seenRouting = new Set<string>();
  for (const log of logs) {
    const text = fs.readFileSync(path.join(dir, log), "utf8");
    for (const m of text.matchAll(/\[tokens\] input: (\d+), output: (\d+), cache read: (\S+?)(?:\s|$)/g)) {
      chatIn += Number(m[1]);
      chatOut += Number(m[2]);
      cacheRead += m[3] === "n/a" ? 0 : Number(m[3]);
    }
    for (const line of text.split("\n")) {
      if (line.startsWith("[skillRouting] {")) {
        if (seenRouting.has(line)) continue;
        seenRouting.add(line);
        try { routeTok += JSON.parse(line.slice("[skillRouting] ".length)).inputTokens ?? 0; } catch { /* partial line */ }
      } else if (line.includes('"browse step decided"')) {
        try {
          const step = JSON.parse(line).browseStep;
          stepTok += step?.inputTokens ?? 0;
          if (step?.textSource === "llm") texts++;
        } catch { /* partial line */ }
      } else if (line.includes('"browse plan produced"') || line.includes("browse plan fell back")) {
        plans++;
      }
    }
  }
  const chat = (chatIn - cacheRead) * PRICE.chatIn + cacheRead * PRICE.chatCacheRead + chatOut * PRICE.chatOut;
  const routing = routeTok * PRICE.decisionIn;
  const steps = stepTok * PRICE.decisionIn;
  const gemini = plans * PRICE.geminiPlanCall + texts * PRICE.geminiTextCall;
  const share = chatIn > 0 ? `${((100 * cacheRead) / chatIn).toFixed(1)}%` : "—";
  console.log(
    `| ${path.basename(dir)} | ${runs} | ${Math.round(chatIn / runs / 1000)}k | ${share} | ${usd(chat / runs)} | ${usd(routing / runs)} | ${usd(steps / runs)} | ${usd(gemini / runs)} | **${usd((chat + routing + steps + gemini) / runs)}** |`,
  );
}
