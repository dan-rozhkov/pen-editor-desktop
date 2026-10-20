import { describe, expect, it } from "vitest";
import { createMigrationGuard } from "../src/main/migrationGuard";

describe("createMigrationGuard", () => {
  it("is active until end(), and end() is idempotent", () => {
    const g = createMigrationGuard();
    expect(g.active).toBe(true);
    g.end();
    expect(g.active).toBe(false);
    g.end();
    expect(g.active).toBe(false);
  });
});
