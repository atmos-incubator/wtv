import { installMediaHook } from '../lib/media/hook';

/**
 * MAIN-world hook. Registered at runtime (see lib/injection.ts) for every origin Wtv has
 * host permission for, so bundled and user-enabled sites share one code path.
 */
export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main() {
    installMediaHook();
  },
});
