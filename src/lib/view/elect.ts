/**
 * Which frame of a tab a maximize or play/pause goes to. Pure.
 *
 *   maximize: frames with a video on screen. Playing beats paused, then the bigger
 *             video, then the top frame.
 *   playback: frames with any primary. The maximized video first (that's what the user
 *             is watching), then whatever is playing (so play/pause pauses it), then the
 *             bigger video, then the top frame.
 */
import type { FrameCandidate } from './messages';

export interface FrameReport {
  frameId: number;
  candidate: FrameCandidate;
}

export type ElectPurpose = 'maximize' | 'playback';

function rank(f: FrameReport, purpose: ElectPurpose): number[] {
  const c = f.candidate;
  const top = f.frameId === 0 ? 1 : 0;
  const area = c.video?.area ?? 0;
  if (purpose === 'maximize') return [c.video?.playing ? 1 : 0, area, top];
  return [c.maximized === 'media' ? 1 : 0, c.media?.playing ? 1 : 0, area, top];
}

function compareDesc(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function electFrame(frames: readonly FrameReport[], purpose: ElectPurpose): number | null {
  const eligible = frames.filter((f) => (purpose === 'maximize' ? f.candidate.video : f.candidate.media));
  if (eligible.length === 0) return null;
  const best = [...eligible].sort((a, b) => compareDesc(rank(a, purpose), rank(b, purpose)))[0];
  return best?.frameId ?? null;
}
