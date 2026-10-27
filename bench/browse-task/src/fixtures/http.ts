// REWRITTEN after the loss of bench/ (27.10.2026). Lines 1-40 (types, serve, html)
// are verbatim from a transcript; json/redirect/readBody/readForm/esc/page were
// rebuilt from their signatures (the exports list and call sites) and may differ in
// detail from the original (e.g. the page() CSS).
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => Promise<void> | void;

export async function serve(handler: Handler): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    Promise.resolve(handler(req, res, url)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function html(res: http.ServerResponse, body: string, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

export function json(res: http.ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

export function redirect(res: http.ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("location", location);
  res.end();
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

export function esc(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 600; }
  input, select, button { font: inherit; padding: .45rem .6rem; }
  button, .btn { background: #1f6feb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
  .error { color: #b42318; font-size: .9rem; }
  ul { padding-left: 1.2rem; }
</style></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}
