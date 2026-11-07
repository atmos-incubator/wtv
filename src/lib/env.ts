import type { DEV_TOOLS_MODES } from './build-mode';

/**
 * True only in dev builds. Gate every dev-only feature (repo writer, snapshot button,
 * etc.) on this so the store build leaves it out.
 *
 * Written as literal comparisons on purpose: Vite replaces `import.meta.env.MODE` with a
 * string, the comparison folds to a constant, and Rollup drops the dead branches. Calling
 * isDevToolsMode() here instead kept every dev feature in the store build (switched off).
 */
export const DEV_TOOLS: boolean = import.meta.env.MODE === 'development' || import.meta.env.MODE === 'devtools';

// Compile-time check that the literals above match the list wxt.config.ts uses.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const modesInSync: Same<typeof DEV_TOOLS_MODES, readonly ['development', 'devtools']> = true;
void modesInSync;
