// Which window answers a browse tool call. McpService is app-global but every window has its own
// built-in browser; a call goes to the most recently active registered one. Pure: window.ts
// registers on create, marks active on focus and unregisters on close.
import type { BrowserBridge } from "@sideform/browser-agent/loop";

export class BrowserHostRegistry {
  /** Least recently active first. */
  private readonly hosts: { key: string | number; bridge: BrowserBridge }[] = [];

  /** Adds a host (a new window counts as active) and returns its unregister function. Re-registering a key replaces it. */
  register(key: string | number, bridge: BrowserBridge): () => void {
    this.remove(key);
    const entry = { key, bridge };
    this.hosts.push(entry);
    return () => {
      // Only this registration: a replacement under the same key stays.
      const i = this.hosts.indexOf(entry);
      if (i >= 0) this.hosts.splice(i, 1);
    };
  }

  /** The window got focus: it becomes the target. Unknown keys are ignored. */
  markActive(key: string | number): void {
    const i = this.hosts.findIndex((h) => h.key === key);
    if (i < 0 || i === this.hosts.length - 1) return;
    const [entry] = this.hosts.splice(i, 1);
    this.hosts.push(entry);
  }

  /** The most recently active host, or null when no window is registered. */
  current(): BrowserBridge | null {
    return this.hosts.length === 0 ? null : this.hosts[this.hosts.length - 1].bridge;
  }

  size(): number {
    return this.hosts.length;
  }

  private remove(key: string | number): void {
    const i = this.hosts.findIndex((h) => h.key === key);
    if (i >= 0) this.hosts.splice(i, 1);
  }
}
