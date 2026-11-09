/**
 * Side panel ⇄ content script messages for the selector picker.
 *
 * Panel → content: browser.tabs.sendMessage (to all frames for start/cancel; to the
 * picked frame for test/roles). Content → panel: browser.runtime.sendMessage.
 */
import { CONDITIONS, ROLE_NAMES, type Condition, type RoleName } from '../sites/schema';
import type { SiteProfile } from '../sites/registry';
import type { Post } from '../posts/adapters';
import type { PostField } from '../posts/page';

export const PICK_START = 'wtv/pick/start';
export const PICK_CANCEL = 'wtv/pick/cancel';
export const PICK_TEST = 'wtv/pick/test';
export const PICK_ROLES = 'wtv/pick/roles';
export const PICK_RESULT = 'wtv/pick/result';
export const PICK_CANCELLED = 'wtv/pick/cancelled';
/** The page's metadata (title, creator, ...) with where each value came from. Top frame. */
export const PICK_METADATA = 'wtv/pick/metadata';
/** → PagePostReport: the post card this page would make (top frame). */
export const PICK_POST = 'wtv/pick/post';
/** → PreviewResult: show that card over the page, as a playlist would, until ✕ (top frame). */
export const PICK_PREVIEW = 'wtv/pick/preview';
/** Keys pressed while the side panel has focus, forwarded to the in-page picker. */
export const PICK_KEY = 'wtv/pick/key';

export const PICK_KEYS = ['up', 'down', 'toggle', 'cancel'] as const;
export type PickKey = (typeof PICK_KEYS)[number];

export type PickRequest =
  | { type: typeof PICK_START; role: RoleName; delayMs: number }
  | { type: typeof PICK_CANCEL }
  | { type: typeof PICK_KEY; key: PickKey }
  | { type: typeof PICK_TEST; role: RoleName; selector: string; when: Condition | null }
  | { type: typeof PICK_ROLES }
  | { type: typeof PICK_METADATA }
  | { type: typeof PICK_POST }
  | { type: typeof PICK_PREVIEW };

export interface Candidate {
  selector: string;
  /** Matches across the whole document (through open shadow roots). */
  count: number;
  score: number;
  /** What it's built on: "id", "test id", "classes", "structure", ... */
  label: string;
}

export interface PickResult {
  type: typeof PICK_RESULT;
  role: RoleName;
  host: string;
  /** Short description of the picked element, e.g. `button.ytp-skip-ad-button`. */
  element: string;
  candidates: Candidate[];
}

export interface TestResult {
  count: number;
  /** The role's condition (exists / visible) is satisfied by at least one match. */
  satisfied: boolean;
  error: string | null;
  /** Metadata and post roles: what the first match reads (its text, or a meta tag's content). */
  value?: string | null;
}

/** PICK_POST's answer: the card this page would make, and what each post role read. */
export interface PagePostReport {
  post: Post | null;
  fields: PostField[];
}

/** PICK_PREVIEW's answer: error says why nothing is shown. */
export interface PreviewResult {
  error: string | null;
}

export interface MatcherReport {
  selector: string;
  when: Condition;
  count: number;
  satisfied: boolean;
  error: string | null;
}

export interface RoleReport {
  role: RoleName;
  source: 'bundled' | 'override' | null;
  matchers: MatcherReport[];
  /** Index of the matcher that currently wins, or null. */
  matchedIndex: number | null;
}

export interface RolesReport {
  host: string;
  profileKind: SiteProfile['kind'];
  siteId: string | null;
  siteName: string | null;
  roles: RoleReport[];
}

const isRole = (v: unknown): v is RoleName => typeof v === 'string' && (ROLE_NAMES as readonly string[]).includes(v);

export function parsePickRequest(raw: unknown): PickRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case PICK_START:
      if (!isRole(m.role)) return null;
      return {
        type: PICK_START,
        role: m.role,
        delayMs: typeof m.delayMs === 'number' && m.delayMs > 0 ? Math.min(m.delayMs, 30_000) : 0,
      };
    case PICK_CANCEL:
      return { type: PICK_CANCEL };
    case PICK_KEY:
      return (PICK_KEYS as readonly unknown[]).includes(m.key) ? { type: PICK_KEY, key: m.key as PickKey } : null;
    case PICK_ROLES:
      return { type: PICK_ROLES };
    case PICK_METADATA:
      return { type: PICK_METADATA };
    case PICK_POST:
      return { type: PICK_POST };
    case PICK_PREVIEW:
      return { type: PICK_PREVIEW };
    case PICK_TEST: {
      if (!isRole(m.role) || typeof m.selector !== 'string') return null;
      const when = (CONDITIONS as readonly unknown[]).includes(m.when) ? (m.when as Condition) : null;
      return { type: PICK_TEST, role: m.role, selector: m.selector, when };
    }
    default:
      return null;
  }
}
