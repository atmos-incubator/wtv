/**
 * Between a post page's content script and the card page it frames for a preview
 * (posts/preview.ts), by postMessage. Both carry the preview's random token, from the
 * card page's URL fragment.
 */
/** Content script → card page: `{ type, token, post }`. */
export const CARD_PREVIEW_POST = 'wtv/card/preview-post';
/** Card page → content script: `{ type, token }` (Esc pressed in the card). */
export const CARD_PREVIEW_CLOSE = 'wtv/card/preview-close';
