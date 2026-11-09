/**
 * How a post card fits its pictures (pure). Two layouts:
 *
 *   - `stack`: the text on top, the pictures below across the card's width (suits wide
 *     pictures, especially on a wide screen);
 *   - `side`: the pictures down one side at the card's full height, the text beside them
 *     (suits tall pictures).
 *
 * and within the pictures' area, rows of pictures: all in one row, one per row, or two
 * per row (3–4 pictures). Each row is as tall as its pictures let it be at the row's
 * width (pictures in a row share one height, widths by their shape), so a block of rows
 * has a known shape and fills its area with nothing cropped.
 *
 * The plan is whichever layout and rows show the pictures biggest, with the text keeping
 * its share of the card (pictureShare: less text, more picture). `side` only on a card
 * wider than tall: on a tall one it would leave the text a narrow strip.
 */
export type CardLayout = 'stack' | 'side';

export interface CardPlan {
  layout: CardLayout;
  /** The pictures' share of the card (pictureShare). */
  share: number;
  /** Pictures per row. */
  perRow: number;
  /** The rows of pictures (indexes into the aspects given), top to bottom. */
  rows: number[][];
  /** Width ÷ height of the whole block of rows. */
  ratio: number;
}

/** The pictures' share of the card's height (stack) or width (side), next to text. */
export const PICTURE_SHARE = 0.55;
/** Next to a line or two (a caption, a short title). */
export const PICTURE_SHARE_CAPTION = 0.7;
/** With no text (no title either): nearly all of it. */
export const PICTURE_SHARE_ALONE = 0.85;
/** Up to this many characters of title + text is a caption. */
export const CAPTION_CHARS = 120;

/** How much of the card the pictures get, by how much text is beside them. */
export function pictureShare(textChars: number): number {
  if (textChars <= 0) return PICTURE_SHARE_ALONE;
  return textChars <= CAPTION_CHARS ? PICTURE_SHARE_CAPTION : PICTURE_SHARE;
}

/** Width ÷ height; anything unusable counts as square. */
const sane = (a: number) => (Number.isFinite(a) && a > 0 ? Math.min(10, Math.max(0.1, a)) : 1);

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The shape of rows of pictures: each row's height at unit width is 1 ÷ (sum of its aspects). */
export function blockRatio(aspects: readonly number[], rows: readonly (readonly number[])[]): number {
  let height = 0;
  for (const row of rows) height += 1 / row.reduce((sum, i) => sum + sane(aspects[i] ?? 1), 0);
  return height > 0 ? 1 / height : 1;
}

/** Area of a `ratio`-shaped block scaled to fit `w` × `h`. */
export function fitArea(w: number, h: number, ratio: number): number {
  if (w <= 0 || h <= 0 || ratio <= 0) return 0;
  return w / h > ratio ? h * h * ratio : (w * w) / ratio;
}

/** `textChars`: title + text, for pictureShare. */
export function planCard(box: { width: number; height: number }, aspects: readonly number[], textChars: number): CardPlan | null {
  const n = aspects.length;
  if (n === 0) return null;
  const share = pictureShare(textChars);
  const regions: Record<CardLayout, [number, number]> = {
    stack: [box.width, box.height * share],
    side: [box.width * share, box.height],
  };
  const perRows = [...new Set([n, 1, ...(n >= 3 ? [2] : [])])];
  let best: CardPlan | null = null;
  let bestArea = -1;
  const layouts: CardLayout[] = box.width >= box.height ? ['stack', 'side'] : ['stack'];
  for (const layout of layouts) {
    for (const perRow of perRows) {
      const rows = chunk([...aspects.keys()], perRow);
      const ratio = blockRatio(aspects, rows);
      const area = fitArea(...regions[layout], ratio);
      // Ties go to the first: stack, then fewer rows.
      if (area > bestArea * 1.0001) {
        best = { layout, share, perRow, rows, ratio };
        bestArea = area;
      }
    }
  }
  return best;
}
