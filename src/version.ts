/**
 * Build marker.
 *
 * Bumped by hand whenever a change ships. It exists for one reason: when
 * something behaves like the previous version, the first question is always
 * "is the new code actually running?" — and guessing from symptoms wastes more
 * time than any feature it took to build.
 *
 * Printed at startup and exposed at GET /v1/status as `build`.
 */
export const BUILD = '0.5.0';

export const BUILD_NOTES = 'twelvedata: strict quote parsing; never report LIVE with zero prices';
