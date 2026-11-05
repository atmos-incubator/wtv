/**
 * Primary-media heuristic. Pure: features in, choice out.
 *
 * A candidate is viable if it has a source and is either visibly on screen (above a
 * minimum size) or playing audibly (covers audio-only players with no geometry).
 * Among viable candidates the highest score wins. The current primary gets a small
 * stickiness bonus so the choice doesn't flicker between near-equal candidates.
 *
 * A site-config match is a strong bonus, not an override: a matched-but-hidden player
 * (e.g. YouTube's watch player while browsing the home page) is still not viable.
 */

export interface CandidateFeatures {
  key: string;
  isVideo: boolean;
  /** !paused && !ended */
  playing: boolean;
  /** !muted && volume > 0 */
  audible: boolean;
  loop: boolean;
  /** Visible area within the viewport, px². */
  visibleArea: number;
  viewportArea: number;
  /** Seconds. Infinity for live streams, NaN when unknown. */
  duration: number;
  hasSource: boolean;
  /** Matched by the site config's `video` role. */
  configMatch: boolean;
}

/** 200×112 px: below this a video is a thumbnail / preview, not the show. */
export const MIN_VISIBLE_AREA = 200 * 112;

export const WEIGHTS = {
  playing: 4,
  audible: 3,
  configMatch: 5,
  /** Scaled by the fraction of the viewport covered (capped at 1). */
  area: 4,
  longDuration: 1,
  shortDuration: -2,
  mutedLoop: -3,
  video: 0.5,
  sticky: 1.5,
} as const;

export const LONG_DURATION_S = 60;
export const SHORT_DURATION_S = 20;

export function isViable(f: CandidateFeatures): boolean {
  if (!f.hasSource) return false;
  return f.visibleArea >= MIN_VISIBLE_AREA || (f.playing && f.audible);
}

export function scoreCandidate(f: CandidateFeatures, isCurrent = false): number | null {
  if (!isViable(f)) return null;
  let score = 0;
  if (f.playing) score += WEIGHTS.playing;
  if (f.playing && f.audible) score += WEIGHTS.audible;
  if (f.configMatch) score += WEIGHTS.configMatch;
  if (f.viewportArea > 0) score += WEIGHTS.area * Math.min(1, f.visibleArea / f.viewportArea);
  if (f.duration === Infinity || f.duration >= LONG_DURATION_S) score += WEIGHTS.longDuration;
  else if (Number.isFinite(f.duration) && f.duration < SHORT_DURATION_S) score += WEIGHTS.shortDuration;
  if (f.loop && !f.audible) score += WEIGHTS.mutedLoop;
  if (f.isVideo) score += WEIGHTS.video;
  if (isCurrent) score += WEIGHTS.sticky;
  return score;
}

export interface PrimaryChoice {
  key: string;
  score: number;
}

/** Highest score wins; ties go to the larger visible area, then the earlier candidate. */
export function pickPrimary(
  candidates: readonly CandidateFeatures[],
  currentKey?: string | null,
): PrimaryChoice | null {
  let best: { f: CandidateFeatures; score: number } | null = null;
  for (const f of candidates) {
    const score = scoreCandidate(f, f.key === currentKey);
    if (score === null) continue;
    if (!best || score > best.score || (score === best.score && f.visibleArea > best.f.visibleArea)) {
      best = { f, score };
    }
  }
  return best ? { key: best.f.key, score: best.score } : null;
}
