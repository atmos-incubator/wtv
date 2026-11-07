/**
 * Overlay page: an extension page framed into sites by the content script (see
 * lib/overlay/host.ts). Plays the ad slideshow / quotes, shows a blackout title, or is a
 * transparent click shield. Runs in the extension origin, so it reads the image library
 * from IndexedDB.
 */
import './style.css';
import { getImageBlob } from '../../lib/images/db';
import { fitMode } from '../../lib/overlay/fit';
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

const ACTIVITY_THROTTLE_MS = 150;
const IDLE_CURSOR_MS = 2500;

const token = location.hash.slice(1);
const root = document.documentElement;
const badge = document.getElementById('badge') as HTMLElement;
const dismiss = document.getElementById('dismiss') as HTMLButtonElement;
const pill = document.getElementById('pill') as HTMLButtonElement;
const prompt = document.getElementById('prompt') as HTMLElement;
const promptStart = document.getElementById('prompt-start') as HTMLButtonElement;
const promptStatus = document.getElementById('prompt-status') as HTMLElement;
const promptButtons = document.getElementById('prompt-buttons') as HTMLElement;
const promptNext = document.getElementById('prompt-next') as HTMLButtonElement;
let front = document.getElementById('layer-a') as HTMLElement;
let back = document.getElementById('layer-b') as HTMLElement;

let port: MessagePort | null = null;
/** Bumped on every command; stale async work checks it and bails. */
let generation = 0;
/** The ad program on screen, so a repeat of the same command doesn't restart it from black. */
let adKey: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let shield = false;
let lastActivity = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const layerUrls = new Map<HTMLElement, string[]>();

function emit(event: OverlayEvent): void {
  port?.postMessage(event);
}

/** Cover if that crops < 20% of the picture, else letterbox. Re-run on resize. */
function applyFit(media: HTMLImageElement | HTMLVideoElement): void {
  const [w, h] =
    media instanceof HTMLVideoElement ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight];
  media.style.objectFit = fitMode(w, h, window.innerWidth, window.innerHeight);
}

function refitAll(): void {
  for (const media of document.querySelectorAll<HTMLImageElement | HTMLVideoElement>('.layer img, .layer video')) {
    applyFit(media);
  }
}

window.addEventListener('resize', refitAll);

function clearLayer(layer: HTMLElement): void {
  layer.classList.remove('visible');
  layer.replaceChildren();
  for (const url of layerUrls.get(layer) ?? []) URL.revokeObjectURL(url);
  layerUrls.delete(layer);
}

function reset(): void {
  generation++;
  adKey = null;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  clearLayer(front);
  clearLayer(back);
  badge.hidden = true;
  dismiss.hidden = true;
  prompt.hidden = true;
  pill.hidden = true;
  root.classList.remove('pill');
  setShield(false, false);
}

/**
 * Shield mode is transparent. That needs the root's color-scheme to match the <iframe>
 * element's (`normal`): when they differ, Chrome paints an opaque backdrop behind the frame.
 */
function setShield(on: boolean, maximized: boolean, seekBand = 0): void {
  shield = on;
  root.style.setProperty('--seek-band', `${on ? seekBand : 0}px`);
  root.classList.toggle('shield', on);
  root.classList.toggle('max', on && maximized);
  root.classList.remove('idle');
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
}

/** Maximized: hide the cursor while the pointer rests, like a TV. */
function wake(): void {
  root.classList.remove('idle');
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = root.classList.contains('max')
    ? setTimeout(() => root.classList.add('idle'), IDLE_CURSOR_MS)
    : undefined;
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
    video.style.objectFit = 'contain';
    video.addEventListener('loadedmetadata', () => applyFit(video), { once: true });
    present(video, urls);
  } else {
    const img = Object.assign(document.createElement('img'), { src: url, alt: '' });
    await img.decode().catch(() => undefined);
    if (gen !== generation) {
      for (const u of urls) URL.revokeObjectURL(u);
      return;
    }
    applyFit(img);
    present(img, urls);
  }
}

async function playAd(cmd: Extract<OverlayCommand, { type: 'ad' }>): Promise<void> {
  reset();
  adKey = JSON.stringify([cmd.host, cmd.items]);
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

let lastBlackoutTitle: string | null = null;
let lastAttempt = 0;

/** Wtv just tried to start playback itself: pulse the Start button, or the status line before Start shows. */
function pulse(target: HTMLElement): void {
  target.classList.remove('pulse');
  void target.offsetWidth; // Restart the animation.
  target.classList.add('pulse');
}

function showBlackout(cmd: Extract<OverlayCommand, { type: 'blackout' }>): void {
  const { title, prompt: offerStart } = cmd;
  // Same title, prompt just appearing: keep the title on screen instead of re-fading it.
  const same = title === lastBlackoutTitle && front.classList.contains('visible');
  if (!same) {
    reset();
    if (title) present(Object.assign(document.createElement('p'), { className: 'title', textContent: title }));
  }
  lastBlackoutTitle = title;
  prompt.hidden = !offerStart && !cmd.status;
  promptButtons.hidden = !offerStart;
  promptNext.hidden = !cmd.canNext;
  promptStatus.textContent = cmd.status ?? '';
  if (cmd.attempt > lastAttempt) pulse(offerStart ? promptStart : promptStatus);
  lastAttempt = cmd.attempt;
}

function handle(cmd: OverlayCommand | null): void {
  if (!cmd) return;
  if (cmd.type !== 'blackout') {
    lastBlackoutTitle = null;
    lastAttempt = 0;
  }
  switch (cmd.type) {
    case 'ad':
      if (adKey === JSON.stringify([cmd.host, cmd.items])) {
        badge.textContent = cmd.muted ? 'Ad · muted' : 'Ad';
        break;
      }
      void playAd(cmd);
      break;
    case 'blackout':
      showBlackout(cmd);
      break;
    case 'shield':
      reset();
      setShield(true, cmd.maximized, cmd.seekBand);
      wake();
      break;
    case 'pill':
      reset();
      root.classList.add('pill');
      pill.hidden = false;
      break;
    case 'hide':
      reset();
      break;
  }
}

pill.addEventListener('click', (e) => {
  e.stopPropagation();
  emit({ type: 'undismiss' });
});

dismiss.addEventListener('click', (e) => {
  e.stopPropagation();
  reset();
  emit({ type: 'dismiss' });
});

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const where = (e: MouseEvent) => ({
  x: clamp(e.clientX / Math.max(1, window.innerWidth)),
  y: clamp(e.clientY / Math.max(1, window.innerHeight)),
});

document.getElementById('prompt-start')!.addEventListener('click', (e) => {
  e.stopPropagation();
  emit({ type: 'start' });
});

document.getElementById('prompt-next')!.addEventListener('click', (e) => {
  e.stopPropagation();
  emit({ type: 'next' });
});

document.addEventListener('click', (e) => {
  if (shield) emit({ type: 'click', ...where(e) });
});

document.addEventListener('dblclick', (e) => {
  if (shield) emit({ type: 'dblclick', ...where(e) });
});

document.addEventListener(
  'mousemove',
  (e) => {
    if (!shield) return;
    wake();
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
    lastActivity = now;
    emit({ type: 'activity', ...where(e) });
  },
  { passive: true },
);

// Focus lands in this frame after a click; hand keys back to the page.
document.addEventListener('keydown', (e) => {
  if (e.key.length === 0 || e.key.length > 32) return;
  // Plain keys only: Space / arrows would otherwise scroll the page behind us. Browser
  // shortcuts (Cmd/Ctrl/Alt + key) keep their default.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
  emit({
    type: 'key',
    key: e.key,
    code: e.code,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    repeat: e.repeat,
  });
});

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (port || !token) return;
  const data = e.data as { type?: unknown; token?: unknown } | null;
  const p = e.ports[0];
  if (!data || data.type !== OVERLAY_INIT || data.token !== token || !p) return;
  port = p;
  port.onmessage = (m: MessageEvent<unknown>) => handle(parseOverlayCommand(m.data));
});
