import type { DEV_TOOLS_MODES, LAN_MODE } from './build-mode';

/**
 * True only in dev builds. Gate every dev-only feature (repo writer, snapshot button,
 * etc.) on this so the store build leaves it out.
 *
 * Written as literal comparisons on purpose: Vite replaces `import.meta.env.MODE` with a
 * string, the comparison folds to a constant, and Rollup drops the dead branches. Calling
 * isDevToolsMode() here instead kept every dev feature in the store build (switched off).
 */
export const DEV_TOOLS: boolean = import.meta.env.MODE === 'development' || import.meta.env.MODE === 'devtools';

/**
 * True only in LAN builds (`npm run lan:build`): the copy a second computer syncs from the dev
 * machine reloads itself when a newer one lands on disk (src/lib/lan/updates.ts). Literal for
 * the same reason as DEV_TOOLS.
 */
export const LAN_BUILD: boolean = import.meta.env.MODE === 'lan';

// Compile-time check that the literals above match the list wxt.config.ts uses.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const modesInSync: Same<typeof DEV_TOOLS_MODES, readonly ['development', 'devtools']> = true;
void modesInSync;
const lanInSync: Same<typeof LAN_MODE, 'lan'> = true;
void lanInSync;
