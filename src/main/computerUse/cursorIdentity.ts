// Who is driving: a label and a colour per live cursor overlay, so two agent chats that control two native apps
// at once draw visibly different cursors (a dark "Agent 2" tooltip, with the agent's colour on the arrow and its glow).

/**
 * Slot 0 is the accent a single agent has always had. The rest keep its OKLCH lightness (L = 0.670) and step the hue
 * by 60 degrees, with chroma clipped to what sRGB can show, so all six read equally bright. Slots are ordered so each
 * next agent is as far in hue as possible from the earlier ones (the complement first). The label pill is a dark
 * tooltip, so the colour is only on the arrow (white outline) and its glow: no text-contrast limit applies.
 */
export const CURSOR_PALETTE: readonly string[] = [
  "#0d99ff", // blue   oklch(0.670 0.183 249.2), the default accent
  "#ce8200", // amber  oklch(0.670 0.146 69.2), +180
  "#b670e8", // violet oklch(0.670 0.183 309.2), +60
  "#71a900", // green  oklch(0.670 0.178 129.2), +240
  "#ee5a7d", // rose   oklch(0.670 0.183 9.2), +120
  "#00aba4", // teal   oklch(0.670 0.116 189.2), +300
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
