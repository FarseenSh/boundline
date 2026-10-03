export interface BlockRange {
  from: number;
  to: number;
}

export interface RangeOptions {
  /** Blocks per range (inclusive width). */
  range: number;
  /** Ranges per source per tick. */
  maxRanges: number;
  /** Blocks behind the head the scan stops at; 1 means never read the head block itself. */
  confirmations?: number;
}

/**
 * Plans the next block ranges to scan: from cursor+1 up to head − confirmations, at most `range` blocks each,
 * at most `maxRanges` of them. Empty when the head is not far enough ahead.
 */
export function planRanges(cursor: number, head: number, opts: RangeOptions): BlockRange[] {
  const confirmations = opts.confirmations ?? 1;
  const limit = head - confirmations;
  const width = Math.max(1, Math.floor(opts.range));
  const out: BlockRange[] = [];
  let from = cursor + 1;
  while (out.length < opts.maxRanges && from <= limit) {
    const to = Math.min(limit, from + width - 1);
    out.push({ from, to });
    from = to + 1;
  }
  return out;
}
