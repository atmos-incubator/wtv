/**
 * Ties the playlist text to its entries list: a line of the textarea can be highlighted
 * (hovering its entry), says which line the pointer is over (to highlight its entry), and
 * can be scrolled into view (a click on its entry).
 *
 * A textarea can't style a line, so a backdrop sits behind it (the textarea's background
 * is transparent): the same text in the same font, padding and wrapping, one element per
 * line, scrolled with it. The highlight is a background on a backdrop line, and line
 * positions are read from it too. It's rebuilt only when the text has changed since.
 */

export interface LineLink {
  /** Highlight a line (0-based, as `PlaylistEntry.line`), or none. */
  highlight(line: number | null): void;
  /** Scroll the text so the line is in the middle, caret at its start, and highlight (flash) it. */
  reveal(line: number): void;
}

const FLASH_MS = 1200;

export function linkLines(textarea: HTMLTextAreaElement, onHoverLine: (line: number | null) => void): LineLink {
  const wrap = document.createElement('div');
  wrap.className = 'text-wrap';
  const backdrop = document.createElement('div');
  backdrop.className = 'text-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'text-lines';
  backdrop.append(inner);
  textarea.before(wrap);
  wrap.append(backdrop, textarea);

  let builtFor: string | null = null;
  let highlighted: number | null = null;
  let hovered: number | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  /** The backdrop's text area as wide as the textarea's (its scrollbar takes room). */
  function fitWidth(): void {
    const style = getComputedStyle(textarea);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const scrollbar = Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders);
    backdrop.style.paddingRight = `${parseFloat(style.paddingRight) + scrollbar}px`;
  }

  function sync(): void {
    inner.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  function ensure(): void {
    if (builtFor === textarea.value) return;
    builtFor = textarea.value;
    inner.replaceChildren(
      ...builtFor.split('\n').map((text) => {
        const line = document.createElement('div');
        // An empty line still takes a line's height.
        line.textContent = text === '' ? ' ' : text;
        return line;
      }),
    );
    const keep = highlighted;
    highlighted = null;
    mark(keep);
    fitWidth();
    sync();
  }

  function mark(line: number | null): void {
    if (highlighted !== null) inner.children[highlighted]?.classList.remove('hl');
    highlighted = line;
    if (line !== null) inner.children[line]?.classList.add('hl');
  }

  /** The line under a point (client coordinates), from the backdrop's layout. */
  function lineAt(clientY: number): number | null {
    ensure();
    const y = clientY - textarea.getBoundingClientRect().top - textarea.clientTop + textarea.scrollTop;
    const lines = inner.children;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as HTMLElement;
      if (y >= line.offsetTop && y < line.offsetTop + line.offsetHeight) return i;
    }
    return null;
  }

  textarea.addEventListener('scroll', sync, { passive: true });
  textarea.addEventListener('mousemove', (e) => {
    const line = lineAt(e.clientY);
    if (line === hovered) return;
    hovered = line;
    onHoverLine(line);
  });
  textarea.addEventListener('mouseleave', () => {
    if (hovered === null) return;
    hovered = null;
    onHoverLine(null);
  });
  // Typing changes the layout: rebuilt on the next highlight or hover, but a shown
  // highlight must not sit on the wrong line meanwhile.
  textarea.addEventListener('input', () => {
    if (highlighted !== null) ensure();
  });
  new ResizeObserver(() => {
    fitWidth();
    sync();
  }).observe(textarea);

  return {
    highlight(line) {
      ensure();
      mark(line);
    },
    reveal(line) {
      ensure();
      const el = inner.children[line] as HTMLElement | undefined;
      if (!el) return;
      // Caret at the start of the line, ready to edit it.
      const start = textarea.value.split('\n').slice(0, line).reduce((n, text) => n + text.length + 1, 0);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, start);
      textarea.scrollTop = el.offsetTop - (textarea.clientHeight - el.offsetHeight) / 2;
      sync();
      wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      mark(line);
      el.classList.remove('flash');
      void el.offsetWidth; // Restart the animation.
      el.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.classList.remove('flash'), FLASH_MS);
    },
  };
}
