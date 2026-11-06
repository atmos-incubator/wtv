/**
 * Recognising a Skip button the site config doesn't list yet (pure; no DOM access
 * beyond the element passed in).
 */

/** Marks a Skip button in its class, id or aria-label (class names are English whatever the UI language). */
const SKIP_HINT = /skip/i;
/** Visible text of a Skip button: English and a few common UI languages. */
const SKIP_TEXT = /^(skip|skip ads?|überspringen|werbung überspringen|passer|ignorer|omitir|saltar|pular|salta)\b/i;
/** "Skip forward 10 seconds", "Skip intro" and the like aren't ad buttons. */
export const NOT_AD_SKIP = /second|forward|backward|\bback\b|intro|recap|credit|navigation/i;
export const SKIP_CANDIDATES = 'button, [role="button"]';

/** A short description of an element for the console: tag#id.class.class. */
export function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const classes = [...el.classList].map((c) => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${id}${classes}`;
}

/** Whether an element looks like an ad's Skip button (name, label or text). */
export function looksLikeSkip(el: Pick<Element, 'id' | 'className' | 'getAttribute' | 'textContent'>): boolean {
  const name = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
  const label = el.getAttribute('aria-label') ?? '';
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (NOT_AD_SKIP.test(`${name} ${label}`) || (text.length <= 40 && NOT_AD_SKIP.test(text))) return false;
  if (SKIP_HINT.test(name) || SKIP_HINT.test(label)) return true;
  return text.length <= 40 && SKIP_TEXT.test(text);
}
