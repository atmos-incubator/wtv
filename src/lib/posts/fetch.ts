/**
 * Background: fetch a post for a `view=card` entry through its site's adapter. Needs host
 * access to the adapter's fetch hosts, if it has any (asked for at Play): those endpoints
 * don't allow cross-origin requests otherwise. Anonymous: never the user's cookies.
 */
import { browser } from 'wxt/browser';
import { originPatternForHost } from '../permissions';
import { findPostAdapter, POST_SITES, type PostResult } from './adapters';

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
  const body = await res.text().catch(() => '');
  return adapter.read(res.status, body, canonical);
}
