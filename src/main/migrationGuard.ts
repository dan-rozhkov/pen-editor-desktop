/** "Startup phase" flag: true from creation until `end()`. While it is true, window-all-closed
 * (the hidden migration window being destroyed) must not quit the app, and `activate` must not
 * open an editor window before the origin migration finished. Pure, so it is unit-tested. */
export interface MigrationGuard {
  readonly active: boolean;
  end(): void;
}

export function createMigrationGuard(): MigrationGuard {
  let active = true;
  return {
    get active() {
      return active;
    },
    end() {
      active = false;
    },
  };
}
