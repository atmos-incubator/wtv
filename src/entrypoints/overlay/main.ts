/**
 * Overlay page: an extension page framed into sites by the content script (see
 * lib/overlay/host.ts). Plays the ad slideshow / quotes, or shows a blackout title.
 * Runs in the extension origin, so it reads the image library from IndexedDB.
 */
import './style.css';
import { getImageBlob } from '../../lib/images/db';
import { bundledResolved, createImageResolver } from '../../lib/images/resolver';
import {
  DEFAULT_AD_ITEMS,
  OVERLAY_INIT,
  buildSlides,
  parseOverlayCommand,
  type OverlayCommand,
  type OverlayEvent,
  type Slide,
} from '../../lib/overlay/program';

const token = location.hash.slice(1);
const badge = document.getElementById('badge') as HTMLElement;
const dismiss = document.getElementById('dismiss') as HTMLButtonElement;
let front = document.getElementById('layer-a') as HTMLElement;
let back = document.getElementById('layer-b') as HTMLElement;

let port: MessagePort | null = null;
/** Bumped on every command; stale async work checks it and bails. */
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const layerUrls = new Map<HTMLElement, string[]>();

function emit(event: OverlayEvent): void {
  port?.postMessage(event);
}

function clearLayer(layer: HTMLElement): void {
  layer.classList.remove('visible');
  layer.replaceChildren();
  for (const url of layerUrls.get(layer) ?? []) URL.revokeObjectURL(url);
  layerUrls.delete(layer);
}

function reset(): void {
  generation++;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  clearLayer(front);
  clearLayer(back);
  badge.hidden = true;
  dismiss.hidden = true;
}

/** Render into the back layer, then cross-fade it to the front. */
function present(node: Node, urls: string[] = []): void {
  clearLayer(back);
  back.append(node);
  layerUrls.set(back, urls);
  back.classList.add('visible');
  front.classList.remove('visible');
  const old = front;
  front = back;
  back = old;
  // The old front fades out, then its content is dropped.
  setTimeout(() => {
    if (old !== front) clearLayer(old);
  }, 700);
}

async function renderSlide(slide: Slide, gen: number): Promise<void> {
  if (slide.kind === 'text') {
    present(Object.assign(document.createElement('blockquote'), { className: 'quote', textContent: slide.text }));
    return;
  }
  let url: string;
  const urls: string[] = [];
  if (slide.src.type === 'url') {
    url = slide.src.url;
  } else {
    const blob = await getImageBlob(slide.src.id);
    if (!blob) return; // Removed since the program was built; skip.
    url = URL.createObjectURL(blob);
    urls.push(url);
  }
  if (gen !== generation) {
    for (const u of urls) URL.revokeObjectURL(u);
    return;
  }
  if (slide.isVideo) {
    const video = Object.assign(document.createElement('video'), {
      src: url,
      muted: true,
      loop: true,
      autoplay: true,
      playsInline: true,
    });
    present(video, urls);
  } else {
    const img = Object.assign(document.createElement('img'), { src: url, alt: '' });
    await img.decode().catch(() => undefined);
    if (gen !== generation) {
      for (const u of urls) URL.revokeObjectURL(u);
      return;
    }
    present(img, urls);
  }
}

async function playAd(cmd: Extract<OverlayCommand, { type: 'ad' }>): Promise<void> {
  reset();
  const gen = generation;
  badge.textContent = cmd.muted ? 'Ad · muted' : 'Ad';
  badge.hidden = false;
  dismiss.hidden = false;

  const resolve = await createImageResolver(cmd.host);
  let slides: Slide[] = [];
  let index = 0;

  const advance = async (): Promise<void> => {
    if (gen !== generation) return;
    if (index >= slides.length) {
      slides = buildSlides(cmd.items, resolve);
      if (slides.length === 0) slides = buildSlides(DEFAULT_AD_ITEMS, bundledResolved);
      index = 0;
    }
    const slide = slides[index++];
    if (!slide) return;
    try {
      await renderSlide(slide, gen);
    } catch (err) {
      console.warn('[wtv] overlay slide failed:', err);
    }
    if (gen !== generation) return;
    timer = setTimeout(() => void advance(), slide.durationMs);
  };
  await advance();
}

function showBlackout(title: string | null): void {
  reset();
  if (title) present(Object.assign(document.createElement('p'), { className: 'title', textContent: title }));
}

function handle(cmd: OverlayCommand | null): void {
  if (!cmd) return;
  switch (cmd.type) {
    case 'ad':
      void playAd(cmd);
      break;
    case 'blackout':
      showBlackout(cmd.title);
      break;
    case 'hide':
      reset();
      break;
  }
}

dismiss.addEventListener('click', () => {
  reset();
  emit({ type: 'dismiss' });
});

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (port || !token) return;
  const data = e.data as { type?: unknown; token?: unknown } | null;
  const p = e.ports[0];
  if (!data || data.type !== OVERLAY_INIT || data.token !== token || !p) return;
  port = p;
  port.onmessage = (m: MessageEvent<unknown>) => handle(parseOverlayCommand(m.data));
});
