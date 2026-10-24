/**
 * Quack: set by scripts/bundle-hub.mjs (esbuild `define`) in the single-file hub and daemon
 * the app ships. Unset when running from dist/.
 */
declare const __QUACK_BUNDLE__: boolean | undefined;
declare const __QUACK_VERSION__: string | undefined;
declare const __QUACK_BUILD__: string | undefined;

export const BUNDLED = typeof __QUACK_BUNDLE__ !== "undefined" && __QUACK_BUNDLE__ === true;

/** The package version baked into a bundle, which has no package.json next to it */
export const BUNDLED_VERSION: string | undefined = typeof __QUACK_VERSION__ !== "undefined" ? __QUACK_VERSION__ : undefined;

/**
 * One id per bundle (the version stays the same across builds). The app compares it with the
 * BUILD file it ships to tell a hub left running from an older install. Kept here, in memory:
 * the installer overwrites the files of a hub that is still running.
 */
export const BUNDLED_BUILD: string | undefined = typeof __QUACK_BUILD__ !== "undefined" ? __QUACK_BUILD__ : undefined;
