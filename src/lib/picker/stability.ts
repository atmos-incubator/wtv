/**
 * Which ids / classes / attribute values are worth building a selector on. Pure.
 *
 * Site rebuilds regenerate hashed class names (CSS modules, CSS-in-JS), framework ids
 * and numeric ids, so selectors on those break first. State classes (`active`, `is-open`)
 * come and go while you watch.
 */

const GENERATED_PREFIX = /^(css|sc|jsx|emotion|styled|tw|svelte|astro|chakra)-/i;
const FRAMEWORK_ID = /^(ember|react|vue|radix|headlessui|mui|rc-|:r)/i;
const STATE_CLASS =
  /^(is|has)-|^(active|hover|hovered|focus|focused|selected|open|opened|closed|visible|hidden|show|shown|disabled|enabled|loading|loaded|playing|paused)$/i;

export function looksGenerated(token: string): boolean {
  if (!token || token.length > 40) return true;
  if (GENERATED_PREFIX.test(token)) return true;
  if (/^[a-f0-9]{6,}$/i.test(token)) return true;
  if (/\d{3,}/.test(token)) return true;
  // CSS-module style hash suffix: Button_root__a1b2c, card-3fk9x
  if (/[_-][a-z0-9]{5,}$/i.test(token) && /\d/.test(token.slice(-6))) return true;
  const digits = token.replace(/\D/g, '').length;
  return digits / token.length > 0.3;
}

export function isStableClass(name: string): boolean {
  return !looksGenerated(name) && !STATE_CLASS.test(name);
}

export function isStableId(id: string): boolean {
  return !looksGenerated(id) && !FRAMEWORK_ID.test(id) && !id.includes(':');
}

export function isStableAttrValue(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 80 || /[\n\r]/.test(v)) return false;
  return !looksGenerated(v.replace(/\s+/g, '-'));
}

/** Attributes worth selecting on, best first, with their base stability score. */
export const ATTRIBUTE_PRIORITY: readonly { pattern: RegExp; score: number; label: string }[] = [
  { pattern: /^data-(testid|test-id|test|qa|cy|e2e)$/, score: 90, label: 'test id' },
  { pattern: /^itemprop$/, score: 85, label: 'itemprop' },
  { pattern: /^data-[a-z0-9-]+$/, score: 75, label: 'data attribute' },
  { pattern: /^(name|property)$/, score: 70, label: 'name' },
];

/** Quote an attribute value for a CSS selector. */
export function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
