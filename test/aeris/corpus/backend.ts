import { describe } from 'vitest';

/**
 * The checks that need the corpus backend actually running. They are the only
 * place the outbox, the ordering of dependent operations, the identifier
 * remapping and the convergence meet a real Spring Boot application, so a run
 * that quietly leaves them out proves much less than it looks.
 *
 * A developer without the backend still gets them skipped, which keeps the
 * everyday loop fast. Anywhere the result is relied upon — CI, a release check
 * — `AERIS_REQUIRE_CORPUS=1` makes a missing backend an error instead of a
 * silence.
 */
export const BASE_URL = process.env.TASKLY_BASE_URL ?? 'http://127.0.0.1:18090';
export const DATABASE_URL = process.env.TASKLY_DATABASE_URL;

const available = DATABASE_URL !== undefined && process.env.TASKLY_BASE_URL !== undefined;

if (!available && process.env.AERIS_REQUIRE_CORPUS === '1') {
  throw new Error(
    'AERIS_REQUIRE_CORPUS=1 but TASKLY_BASE_URL / TASKLY_DATABASE_URL are unset: the corpus end-to-end '
    + 'checks would be skipped. Start the corpus backend and point them at it, or unset AERIS_REQUIRE_CORPUS.',
  );
}

/** `describe` when the corpus backend is reachable, a skip otherwise. */
export const suite = available ? describe : describe.skip;
