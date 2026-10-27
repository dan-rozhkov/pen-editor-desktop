import http from "node:http";
import { BrowserController } from "../vendor/controller";
import { PlaywrightTarget } from "./playwrightHandle";

const PORT = Number(process.env.PORT ?? 8787);
const target = new PlaywrightTarget();
const controller = new BrowserController(target, { cursor: process.env.CURSOR !== "0" });
const CMDS = ["open", "act", "findImages", "read", "snapshot", "screenshot", "tabs", "perform"] as const;

http
  .createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
      const m = req.url?.match(/^\/cmd\/(\w+)/);
      if (req.method === "POST" && m && (CMDS as readonly string[]).includes(m[1])) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : undefined;
        const t0 = Date.now();
        const result = await (controller as any)[m[1]](body);
        return send(200, { result, serverMs: Date.now() - t0 });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log(`worker listening on ${PORT}`));
