import { describe } from 'vitest';

/**
 * The suites that need a real PostgreSQL. They are the only place where the
 * change log, the scope filtering and the whole offline write → reconcile →
 * converge cycle run against a database rather than a fixture, so a run that
 * quietly leaves them out is a green tick that proves much less than it looks.
 *
 * A developer without a database still gets them skipped, which keeps the
 * everyday loop fast. Anywhere the result is relied upon — CI, a release check
 * — `AERIS_REQUIRE_INTEGRATION=1` makes the absence of a database an error
 * instead of a silence.
 */
export const DATABASE_URL = process.env.AERIS_TEST_DATABASE_URL;

if (DATABASE_URL === undefined && process.env.AERIS_REQUIRE_INTEGRATION === '1') {
  throw new Error(
    'AERIS_REQUIRE_INTEGRATION=1 but AERIS_TEST_DATABASE_URL is unset: the integration suites would be skipped. '
    + 'Start a PostgreSQL and point AERIS_TEST_DATABASE_URL at it, or unset AERIS_REQUIRE_INTEGRATION.',
  );
}

/** `describe` when a database is reachable, a skip otherwise. */
export const suite = DATABASE_URL === undefined ? describe.skip : describe;
