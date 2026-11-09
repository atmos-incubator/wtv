/**
 * Between a post page's content script and the card page it frames over itself
 * (posts/embed.ts, posts/preview.ts), by postMessage. The page checks `source` is the
 * card's frame; the card checks `source` is its parent.
 */
/** Content script → card page: `{ type, token, post }` (a preview's post, with its token). */
export const CARD_PREVIEW_POST = 'wtv/card/preview-post';
/** Card page → content script: `{ type, token }` (Esc pressed in a preview's card). */
export const CARD_PREVIEW_CLOSE = 'wtv/card/preview-close';
/** Card page → content script: `{ type }`, the pointer moved over the card (wakes the arrows). */
export const CARD_POINTER = 'wtv/card/pointer';
/**
 * `{ type, paused }` both ways, beside an embedded player: the viewer paused (or played)
 * the card, so the player follows; or the player, so the card's time follows.
 */
export const CARD_PAUSED = 'wtv/card/paused';
