import { isDevToolsMode } from './build-mode';

/**
 * True only in dev builds. Gate every dev-only feature (repo writer, etc.) on this
 * so Vite can dead-code-eliminate it from the store build.
 */
export const DEV_TOOLS: boolean = isDevToolsMode(import.meta.env.MODE);
