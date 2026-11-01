// Who is driving: a label and a colour per live cursor overlay, so two agent chats that control two native apps
// at once draw visibly different cursors (a pill "Agent 2" in its own colour, like agent-desktop).

/**
 * Slot 0 is the accent a single agent has always had. The rest are mid-dark tones of clearly different hue: the
 * pill text is white 11px semibold, so every colour must keep enough contrast with white (no yellow or light tones).
 */
export const CURSOR_PALETTE: readonly string[] = [
  "#0d99ff", // blue (the default accent)
  "#d6336c", // magenta
  "#2f9e44", // green
  "#e8590c", // orange
  "#7048e8", // violet
  "#e03131", // red
];

export interface CursorIdentity {
  label: string;
  color: string;
}

export interface CursorSlotAllocator {
  /** The lowest free slot index (0, 1, 2, ...; unbounded). */
  acquire(): number;
  /** Free a slot. Releasing a free or unknown slot does nothing. */
  release(slot: number): void;
  /** How many slots are held right now. */
  inUse(): number;
}

export const cursorIdentityFor = (slot: number): CursorIdentity => ({
  label: `Agent ${slot + 1}`,
  color: CURSOR_PALETTE[slot % CURSOR_PALETTE.length],
});

export function createCursorSlotAllocator(): CursorSlotAllocator {
  const used = new Set<number>();
  return {
    acquire() {
      let n = 0;
      while (used.has(n)) n++;
      used.add(n);
      return n;
    },
    release(slot) {
      used.delete(slot);
    },
    inUse: () => used.size,
  };
}

/** The one allocator shared by every overlay in the process. */
export const cursorSlots: CursorSlotAllocator = createCursorSlotAllocator();
