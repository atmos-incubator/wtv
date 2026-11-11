/**
 * ISOLATED-world registry of media candidates.
 *
 * Two kinds of handle, same interface:
 *   - direct:  an element this world can touch (document or open shadow root).
 *   - bridged: an element only the MAIN-world hook can touch (detached or in a closed
 *              shadow root). State arrives over EVT_BRIDGE; commands go back over
 *              EVT_COMMAND.
 */
import { visibleAreaOf, isElementVisible } from '../dom/query';
import { EVT_COMMAND, skipElement, type BridgeCommand, type BridgedMediaState } from './protocol';
import type { CandidateFeatures } from './score';

export type HandleKind = 'direct' | 'bridged';

/**
 * Outcome of play(). `blocked`: Chrome's autoplay policy refused (NotAllowedError).
 * `unknown`: a bridged element, whose promise stays in the page's world.
 */
export type PlayResult = 'playing' | 'blocked' | 'failed' | 'unknown';

export interface MediaHandle {
  readonly key: string;
  readonly kind: HandleKind;
  /** Only for direct handles. */
  readonly element: HTMLMediaElement | null;
  features(configMatch: HTMLMediaElement | null): CandidateFeatures;
  /** Viewport rect, when there's something on screen to point at. */
  rect(): DOMRect | null;
  play(): Promise<PlayResult>;
  pause(): void;
  seek(seconds: number): void;
  /** Seconds back (−) or forward from where it is, within the media. */
  skip(by: number): void;
  setMuted(muted: boolean): void;
  /** 0–1, as the element has it (muted aside). */
  volume(): number;
  setVolume(volume: number): void;
  muted(): boolean;
}

const MEDIA_EVENTS = [
  'play',
  'pause',
  'playing',
  'ended',
  'emptied',
  'loadedmetadata',
  'durationchange',
  'volumechange',
] as const;

function viewportArea(): number {
  return window.innerWidth * window.innerHeight;
}

class DirectHandle implements MediaHandle {
  readonly kind = 'direct';
  constructor(
    readonly key: string,
    readonly element: HTMLMediaElement,
  ) {}

  features(configMatch: HTMLMediaElement | null): CandidateFeatures {
    const el = this.element;
    const visible = el.isConnected && isElementVisible(el);
    return {
      key: this.key,
      isVideo: el instanceof HTMLVideoElement,
      playing: !el.paused && !el.ended,
      audible: !el.muted && el.volume > 0,
      loop: el.loop,
      visibleArea: visible
        ? visibleAreaOf(el.getBoundingClientRect(), window.innerWidth, window.innerHeight)
        : 0,
      viewportArea: viewportArea(),
      duration: el.duration,
      hasSource: Boolean(el.currentSrc) || el.readyState > 0,
      configMatch: el === configMatch,
    };
  }

  rect(): DOMRect | null {
    return this.element.isConnected ? this.element.getBoundingClientRect() : null;
  }

  async play(): Promise<PlayResult> {
    try {
      await this.element.play();
      return 'playing';
    } catch (err) {
      return (err as { name?: unknown } | null)?.name === 'NotAllowedError' ? 'blocked' : 'failed';
    }
  }
  pause(): void {
    this.element.pause();
  }
  seek(seconds: number): void {
    this.element.currentTime = seconds;
  }
  skip(by: number): void {
    skipElement(this.element, by);
  }
  setMuted(muted: boolean): void {
    this.element.muted = muted;
  }
  volume(): number {
    return this.element.volume;
  }
  setVolume(volume: number): void {
    this.element.volume = volume;
  }
  muted(): boolean {
    return this.element.muted;
  }
}

class BridgedHandle implements MediaHandle {
  readonly kind = 'bridged';
  readonly element = null;
  constructor(
    readonly key: string,
    public state: BridgedMediaState,
  ) {}

  features(): CandidateFeatures {
    const s = this.state;
    return {
      key: this.key,
      isVideo: s.isVideo,
      playing: !s.paused && !s.ended,
      audible: !s.muted && s.volume > 0,
      loop: s.loop,
      visibleArea: s.area,
      viewportArea: viewportArea(),
      duration: s.live ? Infinity : (s.duration ?? NaN),
      hasSource: s.hasSource,
      configMatch: false,
    };
  }

  rect(): DOMRect | null {
    return null;
  }

  private send(cmd: BridgeCommand): void {
    document.dispatchEvent(new CustomEvent(EVT_COMMAND, { detail: JSON.stringify(cmd) }));
  }
  play(): Promise<PlayResult> {
    this.send({ id: this.state.id, cmd: 'play' });
    return Promise.resolve('unknown');
  }
  pause(): void {
    this.send({ id: this.state.id, cmd: 'pause' });
  }
  seek(seconds: number): void {
    this.send({ id: this.state.id, cmd: 'seek', time: seconds });
  }
  skip(by: number): void {
    this.send({ id: this.state.id, cmd: 'skip', by });
  }
  setMuted(muted: boolean): void {
    this.send({ id: this.state.id, cmd: 'mute', muted });
  }
  volume(): number {
    return this.state.volume;
  }
  setVolume(volume: number): void {
    this.send({ id: this.state.id, cmd: 'volume', volume });
    // The page reports the change back, but the next ↑ / ↓ may come first.
    this.state = { ...this.state, volume };
  }
  muted(): boolean {
    return this.state.muted;
  }
}

export class MediaRegistry {
  private readonly direct = new Map<HTMLMediaElement, DirectHandle>();
  private readonly bridged = new Map<number, BridgedHandle>();
  private seq = 0;

  constructor(
    private readonly onChange: () => void,
    private readonly signal: AbortSignal,
  ) {}

  /** Returns true if the element was new. */
  addDirect(el: HTMLMediaElement): boolean {
    if (this.direct.has(el)) return false;
    const handle = new DirectHandle(`d${++this.seq}`, el);
    this.direct.set(el, handle);
    for (const type of MEDIA_EVENTS) {
      el.addEventListener(type, this.onChange, { signal: this.signal, passive: true });
    }
    this.onChange();
    return true;
  }

  updateBridged(state: BridgedMediaState): void {
    const existing = this.bridged.get(state.id);
    if (existing) existing.state = state;
    else this.bridged.set(state.id, new BridgedHandle(`b${state.id}`, state));
    this.onChange();
  }

  removeBridged(id: number): void {
    if (this.bridged.delete(id)) this.onChange();
  }

  /** Forget direct elements no longer in the document. Returns how many were dropped. */
  pruneDisconnected(): number {
    let dropped = 0;
    for (const [el] of this.direct) {
      if (!el.isConnected) {
        this.direct.delete(el);
        dropped++;
      }
    }
    return dropped;
  }

  handles(): MediaHandle[] {
    return [...this.direct.values(), ...this.bridged.values()];
  }

  get(key: string): MediaHandle | undefined {
    return this.handles().find((h) => h.key === key);
  }

  get size(): number {
    return this.direct.size + this.bridged.size;
  }
}
