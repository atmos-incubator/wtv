/**
 * Where a card with an embedded player puts things (pure). The card page (inside the
 * post's page, full viewport) lays the post out in `text`, and the content script lifts
 * the player over `slot`. Both work it out from the same viewport size, so they agree
 * without talking to each other.
 *
 * Landscape: player left (about 60%), post right. Portrait: player on top, post below.
 */
import { cardDurationS, type Post } from './adapters';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EmbedLayout {
  slot: Box;
  text: Box;
}

const SLOT_SHARE = 0.6;

export function embedLayout(width: number, height: number): EmbedLayout {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  const m = Math.round(Math.min(w, h) * 0.04);
  if (w >= h) {
    const slotW = Math.round((w - 3 * m) * SLOT_SHARE);
    return {
      slot: { left: m, top: m, width: slotW, height: h - 2 * m },
      text: { left: 2 * m + slotW, top: m, width: w - 3 * m - slotW, height: h - 2 * m },
    };
  }
  const slotH = Math.round((h - 3 * m) * SLOT_SHARE);
  return {
    slot: { left: m, top: m, width: w - 2 * m, height: slotH },
    text: { left: m, top: 2 * m + slotH, width: w - 2 * m, height: h - 3 * m - slotH },
  };
}

/** How long a card with an embed shows without `dur=`, at least: the player's length isn't known. */
export const EMBED_DEFAULT_S = 60;

export function embedCardDurationS(post: Pick<Post, 'title' | 'text' | 'images'>): number {
  return Math.max(EMBED_DEFAULT_S, cardDurationS(post));
}
