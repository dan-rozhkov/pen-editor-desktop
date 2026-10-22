// fillLogin against a sign-in page that hydrates late (see fixtures/hydrationLogin.ts).
// Typing lands before the app listens: with mode=keep the DOM shows the text but
// the app state is empty; with mode=reset hydration clears the fields. Either way
// a one-shot type + Enter used to leave the page on /login. The user must end up
// on /dashboard. The credential store is seeded on disk and safeStorage is faked
// (decrypt = drop the leading "x"), so no Keychain is touched.

import { test, expect } from "@playwright/test";
import { launchShell } from "./launch";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HYDRATION_PASSWORD,
  HYDRATION_USER,
  startHydrationLoginServer,
  type HydrationLoginServer,
} from "./fixtures/hydrationLogin";

let fixture: HydrationLoginServer;
let userData: string;

test.beforeAll(async () => {
  fixture = await startHydrationLoginServer();
  userData = mkdtempSync(path.join(tmpdir(), "pen-desktop-hydration-e2e-"));
  writeFileSync(
    path.join(userData, "browser-credentials.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "h1",
          origin: fixture.baseUrl,
          username: HYDRATION_USER,
          label: "qa",
          password: Buffer.from(`x${HYDRATION_PASSWORD}`).toString("base64"),
        },
      ],
      never: [],
    }),
  );
});

test.afterAll(async () => {
  await fixture.close();
  rmSync(userData, { recursive: true, force: true });
});

for (const mode of ["keep", "reset"] as const) {
  test(`fillLogin signs in to a late-hydrating page (mode=${mode})`, async () => {
    test.setTimeout(90_000);
    const app = await launchShell({
      args: ["."],
      env: { ...process.env, PEN_DESKTOP_URL: fixture.baseUrl, PEN_DESKTOP_USER_DATA_DIR: userData },
    });
    try {
      await expect(app.canvasPage.locator("#ready")).toHaveText("stub-editor");
      await app.evaluate(({ safeStorage }) => {
        const s = safeStorage as unknown as Record<string, unknown>;
        s.isEncryptionAvailable = () => true;
        s.decryptString = (b: Buffer) => b.toString().slice(1);
        s.encryptString = (p: string) => Buffer.from(`x${p}`);
      });

      const filled = await app.canvasPage.evaluate(async (url) => {
        const b = (window as unknown as { penDesktop: { browser: Record<string, (a?: unknown) => Promise<unknown>> } })
          .penDesktop.browser;
        await b.open({ url });
        return await b.fillLogin({ submit: true });
      }, `${fixture.baseUrl}/login?hydrateMs=1500&mode=${mode}`);
      console.log(`[hydration ${mode}] fillLogin result: ${JSON.stringify(filled)}`);
      expect(JSON.stringify(filled)).not.toContain(HYDRATION_PASSWORD);
      expect(JSON.stringify(filled)).not.toContain(HYDRATION_USER);

      const page =
        app.windows().find((p) => p.url().startsWith(fixture.baseUrl + "/login") || p.url().startsWith(fixture.baseUrl + "/dashboard")) ??
        (await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(fixture.baseUrl + "/") }));
      await expect(page.locator("#ws")).toHaveText("QA Workspace", { timeout: 15_000 });
      expect(page.url()).toBe(`${fixture.baseUrl}/dashboard`);
    } finally {
      await app.close();
    }
  });
}
