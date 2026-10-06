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

const FILES = [
  { path: 'acme/platform/Caller.java', content: SESSION },
  { path: 'acme/platform/CallTrace.java', content: TELEMETRY },
  { path: 'acme/platform/CallScope.java', content: HOLDER },
  { path: 'acme/platform/ActivityAuditPort.java', content: BOOKKEEPING },
  { path: 'acme/platform/Chronicle.java', content: QUIET_BOOKKEEPING },
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
});
