/**
 * Build modes:
 *   - `development` (`npm run dev`)        → dev tools ON
 *   - `devtools`    (`npm run build:dev`)  → dev tools ON, production-style build
 *   - anything else (`npm run build`/`zip`) → store build, dev tools OFF
 *
 * Fail-safe: an unrecognized mode is treated as a store build.
 *
 * Kept free of `import.meta.env` so wxt.config.ts can import it at config time.
 */
export const DEV_TOOLS_MODES = ['development', 'devtools'] as const;

export function isDevToolsMode(mode: string | undefined): boolean {
  return (DEV_TOOLS_MODES as readonly string[]).includes(mode ?? '');
}
