import { installMediaHook } from '../lib/media/hook';
import { BUNDLED_MATCHES } from '../lib/sites/bundled';

/**
 * MAIN-world hook. Registered at runtime (see lib/injection.ts) for every origin Wtv has
 * host permission for, so bundled and user-enabled sites share one code path.
 *
 * `matches` isn't used for registration. WXT uses it for host_permissions (already
 * there, deduped) and for dev-mode tab reloads, which crash without it.
 */
export default defineContentScript({
  registration: 'runtime',
  matches: BUNDLED_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main() {
    installMediaHook();
  },
});
