/**
 * Background: fetch a post for a `view=card` entry through its site's adapter. Needs host
 * access to the adapter's fetch host (asked for at Play): the endpoints don't allow
 * cross-origin requests otherwise.
 */
import { browser } from 'wxt/browser';
import { originPatternForHost } from '../permissions';
import type { PostResult } from '../playlist/messages';
import { findPostAdapter, POST_SITES } from './adapters';

const FETCH_TIMEOUT_MS = 10_000;

export async function fetchPost(url: string): Promise<PostResult> {
  const found = findPostAdapter(url);
  if (!found) return { ok: false, gone: false, error: `Wtv can only show posts from ${POST_SITES} so far` };
  const { adapter, canonical } = found;
  const origins = adapter.fetchHosts.map(originPatternForHost);
  if (!(await browser.permissions.contains({ origins }))) {
    return {
      ok: false,
      gone: false,
      error: `Wtv needs access to ${adapter.fetchHosts.join(', ')} to show ${adapter.site} posts. Play the playlist again to allow it.`,
    };
  }
  let res: Response;
  try {
    res = await fetch(adapter.endpoint(canonical), {
      credentials: 'omit',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, gone: false, error: `Couldn’t reach ${adapter.site}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Deleted, or private (protected accounts): it won't play either way.
  if (res.status === 404 || res.status === 410 || res.status === 403) {
    return { ok: false, gone: true, error: `${adapter.site} says this post isn’t available` };
  }
  if (!res.ok) return { ok: false, gone: false, error: `${adapter.site} answered ${res.status}` };
  const post = adapter.parse(await res.json().catch(() => null), canonical);
  return post ? { ok: true, post } : { ok: false, gone: false, error: `Couldn’t read ${adapter.site}’s answer` };
}
