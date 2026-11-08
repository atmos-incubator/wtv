/**
 * The overlay's article reader (`view=read`). Given a snapshot of the page, finds its
 * article with Readability (Firefox Reader View's library), shows it as large, TV-legible
 * text, and scrolls it at a reading pace (page-show/pace.ts).
 *
 * The snapshot is parsed with DOMParser, which runs nothing; the article is rebuilt from
 * its text and picture URLs only (no page markup, links or styles survive), so nothing of
 * the page can act in the extension origin.
 */
import { Readability } from '@mozilla/readability';
import { countWords, readPlan, readScrollTop, type ReadPlan } from '../../lib/page-show/pace';
import type { OverlayEvent, ReadCommand } from '../../lib/overlay/program';

/** Less text than this isn't an article: scroll the page instead. */
const MIN_ARTICLE_CHARS = 500;
const MAX_BLOCKS = 3000;
const MAX_IMAGES = 40;

export interface Reader {
  togglePause(): void;
  stop(): void;
}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI', 'FIGCAPTION', 'DT', 'DD', 'TR']);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

const tidy = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function imageUrl(img: Element, base: string): string | null {
  const raw = img.getAttribute('src') ?? img.getAttribute('data-src');
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Readability's article HTML → plain blocks of our own. */
function rebuild(content: string, base: string, into: HTMLElement): void {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  let blocks = 0;
  let images = 0;
  const add = (node: HTMLElement) => {
    if (blocks++ < MAX_BLOCKS) into.append(node);
  };

  const walk = (parent: Element) => {
    let loose = '';
    const flush = () => {
      const text = tidy(loose);
      if (text) add(el('p', '', text));
      loose = '';
    };
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        loose += child.textContent ?? '';
        continue;
      }
      if (!(child instanceof Element)) continue;
      const tag = child.tagName;
      if (tag === 'IMG') {
        flush();
        const src = imageUrl(child, base);
        if (src && images++ < MAX_IMAGES) {
          const img = el('img', 'pic');
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.src = src;
          img.addEventListener('error', () => img.remove(), { once: true });
          add(img);
        }
        continue;
      }
      if (BLOCK_TAGS.has(tag) && !child.querySelector('p, img, li, blockquote, pre')) {
        flush();
        const text = tag === 'PRE' ? (child.textContent ?? '').trim() : tidy(child.textContent);
        if (!text) continue;
        if (/^H[1-6]$/.test(tag)) add(el(tag === 'H1' || tag === 'H2' ? 'h2' : 'h3', '', text));
        else if (tag === 'BLOCKQUOTE') add(el('blockquote', '', text));
        else if (tag === 'PRE') add(el('pre', '', text));
        else if (tag === 'LI') add(el('p', 'item', text));
        else if (tag === 'FIGCAPTION') add(el('p', 'caption', text));
        else add(el('p', '', text));
        continue;
      }
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'BUTTON', 'FORM'].includes(tag)) continue;
      // Inline at block level (a link, emphasis): part of the loose text.
      if (['A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'CODE', 'SMALL', 'SUP', 'SUB', 'MARK', 'ABBR', 'TIME', 'BR'].includes(tag)) {
        loose += tag === 'BR' ? ' ' : (child.textContent ?? '');
        continue;
      }
      flush();
      walk(child);
    }
    flush();
  };
  walk(doc.body);
}

export function startReader(cmd: ReadCommand, box: HTMLElement, emit: (e: OverlayEvent) => void): Reader {
  let stopped = false;
  let raf = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  let plan: ReadPlan | null = null;
  let shownS = 0;
  let runningSince: number | null = null;
  const column = el('article', 'read-column');

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearInterval(tick);
    box.replaceChildren();
    box.hidden = true;
  };

  // Parse after this task, so the command handler returns first.
  setTimeout(() => {
    if (stopped) return;
    let article: ReturnType<Readability['parse']> = null;
    try {
      const doc = new DOMParser().parseFromString(cmd.html, 'text/html');
      // Relative links and pictures resolve against the page, not the overlay.
      const base = doc.createElement('base');
      base.href = cmd.url;
      doc.head.prepend(base);
      article = new Readability(doc, { charThreshold: MIN_ARTICLE_CHARS }).parse();
    } catch (err) {
      console.warn('[wtv] Readability failed:', err);
    }
    if (stopped) return;
    if (!article?.content || tidy(article.textContent).length < MIN_ARTICLE_CHARS) {
      emit({ type: 'read-failed', id: cmd.id });
      return;
    }

    const head = el('header', 'read-head');
    if (article.siteName) head.append(el('p', 'site', tidy(article.siteName)));
    const title = tidy(article.title);
    if (title) head.append(el('h1', '', title));
    if (article.byline) head.append(el('p', 'byline', tidy(article.byline)));
    column.append(head);
    rebuild(article.content, cmd.url, column);
    box.replaceChildren(column);
    box.hidden = false;

    const words = countWords(`${title} ${article.textContent ?? ''}`);
    plan = readPlan(words, cmd.wpm, cmd.durS);
    runningSince = performance.now();
    emit({ type: 'read-started', id: cmd.id, durationS: Math.round(plan.totalS) });
    loop();
    // rAF stops in a hidden tab; the timer still ends the show on time.
    tick = setInterval(step, 1000);
  }, 0);

  const elapsedS = () => shownS + (runningSince === null ? 0 : (performance.now() - runningSince) / 1000);

  function step(): void {
    if (stopped || !plan) return;
    const t = elapsedS();
    // Pictures load as it goes, so measure every time.
    const top = readScrollTop(t, plan, column.scrollHeight, box.clientHeight);
    column.style.transform = `translateY(${-top}px)`;
    box.style.setProperty('--progress', String(Math.min(1, t / plan.totalS)));
    if (t >= plan.totalS) {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(tick);
      emit({ type: 'read-done', id: cmd.id });
    }
  }

  function loop(): void {
    step();
    raf = !stopped && runningSince !== null ? requestAnimationFrame(loop) : 0;
  }

  return {
    togglePause() {
      if (stopped || !plan) return;
      if (runningSince === null) {
        runningSince = performance.now();
        if (!raf) loop();
      } else {
        shownS = elapsedS();
        runningSince = null;
      }
      box.classList.toggle('paused', runningSince === null);
    },
    stop,
  };
}
