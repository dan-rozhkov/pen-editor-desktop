// Child of judge.ts: runs under `infisical run` so OPENROUTER_API_KEY exists.
// usage: tsx judgeWorker.ts <input.json> <output.json>
import fs from "node:fs";
import { callJudge, type JudgeInput } from "./judge.ts";

const [inFile, outFile] = process.argv.slice(2);
try {
  const result = await callJudge(JSON.parse(fs.readFileSync(inFile, "utf8")) as JudgeInput);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
