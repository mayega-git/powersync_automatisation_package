import { describe, expect, it } from 'vitest';
import { detectConfig } from '../../../src/aeris/compiler/init.js';

/**
 * `aeris init` is the door any backend comes through, so it must find the
 * session holder, the request-metadata holder and the bookkeeping candidates
 * by their *shape*. Nothing here follows the naming of the backend AERIS was
 * developed against: the package, the classes and the claims are all unrelated.
 */
const SESSION = `
package acme.platform;
import java.util.UUID;
public record Caller(UUID workspaceId, UUID memberId, String locale) {}
`;

const TELEMETRY = `
package acme.platform;
public record CallTrace(String traceId, String remoteAddress, String userAgent) {}
`;

const HOLDER = `
package acme.platform;
import java.util.Optional;
import reactor.core.publisher.Mono;
public final class CallScope {
  private CallScope() {}
  public static Mono<Caller> caller() {
    return Mono.deferContextual(ctx -> Mono.just(ctx.get("caller")));
  }
  public static Mono<Optional<Caller>> callerIfAny() {
    return Mono.deferContextual(ctx -> Mono.just(ctx.hasKey("caller") ? Optional.of((Caller) ctx.get("caller")) : Optional.empty()));
  }
  public static Mono<Optional<CallTrace>> trace() {
    return Mono.deferContextual(ctx -> Mono.just(ctx.hasKey("trace") ? Optional.of((CallTrace) ctx.get("trace")) : Optional.empty()));
  }
}
`;

const BOOKKEEPING = `
package acme.platform;
import reactor.core.publisher.Mono;
public interface ActivityAuditPort {
  Mono<Void> write(String action);
  Mono<Void> purge();
  Mono<String> lastAction();
}
`;

/** Says nothing in its name; only the verb betrays the bookkeeping. */
const QUIET_BOOKKEEPING = `
package acme.platform;
import reactor.core.publisher.Mono;
public interface Chronicle {
  Mono<Void> recordChange(String what);
  Mono<Void> rebuildEverything();
}
`;

/** A holder handing back one identifier, next to a record that names the claim. */
const CLAIM_HOLDER = `
package acme.platform;
import java.util.UUID;
import reactor.core.publisher.Mono;
public final class CallClaims {
  private CallClaims() {}
  public static Mono<UUID> currentWorkspaceId() {
    return Mono.deferContextual(ctx -> Mono.just(((Caller) ctx.get("caller")).workspaceId()));
  }
  public static Mono<String> currentLocale() {
    return Mono.deferContextual(ctx -> Mono.just(((Caller) ctx.get("caller")).locale()));
  }
}
`;

/** The other shape: a ThreadLocal a filter fills, with no session record at all. */
const BLOCKING_HOLDER = `
package other.legacy;
import java.util.UUID;
public final class SiteContext {
  private static final ThreadLocal<UUID> site = new ThreadLocal<>();
  private static final ThreadLocal<String> actor = new ThreadLocal<>();
  private SiteContext() {}
  public static void setSiteId(UUID value) { site.set(value); }
  public static UUID getSiteId() { return site.get(); }
  public static String getActor() { return actor.get(); }
}
`;

const FILES = [
  { path: 'acme/platform/Caller.java', content: SESSION },
  { path: 'acme/platform/CallTrace.java', content: TELEMETRY },
  { path: 'acme/platform/CallScope.java', content: HOLDER },
  { path: 'acme/platform/ActivityAuditPort.java', content: BOOKKEEPING },
  { path: 'acme/platform/Chronicle.java', content: QUIET_BOOKKEEPING },
  { path: 'acme/platform/CallClaims.java', content: CLAIM_HOLDER },
];

const detect = () => detectConfig('/nonexistent-root', FILES);

describe('aeris init on an unfamiliar backend', () => {
  it('finds the session holder in both its required and optional forms', async () => {
    const { yaml } = await detect();
    expect(yaml).toContain('method: CallScope.caller');
    expect(yaml).toContain('kind: required');
    expect(yaml).toContain('method: CallScope.callerIfAny');
    expect(yaml).toContain('kind: optional');
    expect(yaml).toContain('type: acme.platform.Caller');
  });

  it('tells a request-metadata holder apart from the session', async () => {
    const { yaml } = await detect();
    const trace = yaml.slice(yaml.indexOf('method: CallScope.trace'));
    expect(trace).toContain('kind: metadata');
    expect(trace).toContain('type: acme.platform.CallTrace');
  });

  it('proposes bookkeeping candidates commented out, never enabled', async () => {
    const { yaml, notes } = await detect();
    expect(yaml).toContain('#   - ActivityAuditPort.write');
    // Returning nothing is not enough to be inert, so the reader decides.
    expect(yaml).toContain('#   - ActivityAuditPort.purge');
    expect(yaml).not.toMatch(/^inertEffects:/m);
    expect(notes.join(' ')).toMatch(/enable only those/);
  });

  it('never proposes a method that answers something', async () => {
    const { yaml } = await detect();
    expect(yaml).not.toContain('ActivityAuditPort.lastAction');
  });

  it('spots bookkeeping by the verb when the class name says nothing', async () => {
    const { yaml } = await detect();
    expect(yaml).toContain('#   - Chronicle.recordChange');
    expect(yaml).not.toContain('Chronicle.rebuildEverything');
  });

  it('takes the scope claims from the session record, not from a fixed vocabulary', async () => {
    const { yaml } = await detect();
    expect(yaml).toContain('workspaceId:');
    expect(yaml).toContain('memberId:');
    // `locale` is not an identifier, and nothing invents tenants here.
    expect(yaml).not.toContain('locale:');
    expect(yaml).not.toContain('tenantId:');
    expect(yaml).not.toContain('organizationId:');
  });

  it('proves a single-claim holder against the session record, and skips what is not an identifier', async () => {
    const { yaml, notes } = await detect();
    const claim = yaml.slice(yaml.indexOf('method: CallClaims.currentWorkspaceId'));
    expect(claim).toContain('kind: claim');
    expect(claim).toContain('claim: workspaceId');
    // A String may be a username, a role or a locale: nothing here says which.
    expect(yaml).not.toContain('CallClaims.currentLocale');
    expect(notes.join(' ')).toMatch(/currentLocale returns a single String/);
  });
});

/**
 * The other half of the organisation: a holder with no session record, whose
 * claims can only be read off the accessor names. Proposing them is the whole
 * value of `aeris init` here -- without them not one endpoint is scoped -- so
 * they are proposed, and the note says to confirm each one.
 */
describe('aeris init on a holder backed by a ThreadLocal', () => {
  const detectLegacy = () => detectConfig('/nonexistent-root', [{ path: 'other/legacy/SiteContext.java', content: BLOCKING_HOLDER }]);

  it('reads the claim off the accessor name and says to confirm it', async () => {
    const { yaml, notes } = await detectLegacy();
    expect(yaml).toContain('method: SiteContext.getSiteId');
    expect(yaml).toContain('claim: siteId');
    expect(yaml).toContain('siteId:');
    expect(notes.join(' ')).toMatch(/'siteId' is a claim name read off the accessor names: confirm/);
  });

  it('leaves the setter and the non-identifier accessor alone', async () => {
    const { yaml, notes } = await detectLegacy();
    expect(yaml).not.toContain('SiteContext.setSiteId');
    expect(yaml).not.toContain('SiteContext.getActor');
    expect(notes.join(' ')).toMatch(/getActor returns a single String/);
  });
});
