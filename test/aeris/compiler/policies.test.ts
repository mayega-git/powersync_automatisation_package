import { describe, expect, it } from 'vitest';
import { Executor } from '../../../src/aeris/runtime/executor.js';
import { compileJava, endpoint } from './helpers.js';

const TOKEN = `
package demo.security;
import java.util.UUID;
import org.springframework.security.authentication.AbstractAuthenticationToken;
public final class SessionToken extends AbstractAuthenticationToken {
  private final UUID tenantId;
  private final UUID organizationId;
  private final UUID userId;
  public SessionToken(UUID tenantId, UUID organizationId, UUID userId) { super(null); this.tenantId = tenantId; this.organizationId = organizationId; this.userId = userId; }
  public UUID tenantId() { return tenantId; }
  public UUID organizationId() { return organizationId; }
  public UUID userId() { return userId; }
  public Object getCredentials() { return null; }
  public Object getPrincipal() { return userId; }
}
`;

const POLICY = `
package demo.security;
import java.util.Set;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.stereotype.Component;
@Component
public class AccessPolicy {
  private static final Set<String> ADMIN_GRANTS = Set.of("products:read", "products:write");
  public boolean hasPermission(Authentication authentication, String permission) {
    if (!hasUserContext(authentication)) return false;
    if (!(authentication instanceof SessionToken token)) return false;
    if (ADMIN_GRANTS.contains(permission) && isAdmin(authentication)) return true;
    if (hasExactAuthority(authentication, permission) || hasExactAuthority(authentication, permission + "#TENANT")) return true;
    return token.organizationId() != null && hasExactAuthority(authentication, permission + "#ORGANIZATION:" + token.organizationId());
  }
  public boolean isAdmin(Authentication authentication) {
    return Set.of("ROLE_ADMIN", "ROLE_ORGANIZATION_ADMIN").stream().anyMatch(role -> hasExactAuthority(authentication, role));
  }
  public boolean hasUserContext(Authentication authentication) {
    return authentication instanceof SessionToken token && authentication.isAuthenticated() && token.userId() != null;
  }
  private boolean hasExactAuthority(Authentication authentication, String authority) {
    return authentication.getAuthorities().stream().map(GrantedAuthority::getAuthority).anyMatch(authority::equals);
  }
}
`;

const CONTROLLER = `
package demo.products;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
public class ProductController {
  @PreAuthorize("@accessPolicy.hasPermission(authentication, 'products:write')")
  @GetMapping("/api/products/check")
  public Mono<String> check() { return Mono.just("ok"); }
  @PreAuthorize("hasRole('AUDITOR') or @accessPolicy.isAdmin(authentication)")
  @GetMapping("/api/products/audit")
  public Mono<String> audit() { return Mono.just("ok"); }
}
`;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('compiled authorization policies', () => {
  it('compiles @PreAuthorize bean calls into checks equal to the Java policy', async () => {
    const artifact = await compileJava({
      'demo/security/SessionToken.java': TOKEN,
      'demo/security/AccessPolicy.java': POLICY,
      'demo/products/ProductController.java': CONTROLLER,
    }, { context: { sources: [{ method: 'RequestContextHolder.getRequiredContext', kind: 'required', type: 'demo.kernel.TenantContext' }], authentication: 'demo.security.SessionToken', authoritiesClaim: 'authorities' } });
    const check = endpoint(artifact, 'GET /api/products/check');
    expect(check.auth.checks).toHaveLength(1);
    expect(check.auth.context).toEqual(expect.arrayContaining(['authorities', 'organizationId', 'userId']));
    const executor = new Executor({ projections: new Map(), serverTimeZone: 'UTC' });
    const decide = (plan: typeof check, claims: Record<string, unknown>) => executor.check(plan, plan.auth.checks![0]!.test, claims as never);
    const user = { tenantId: 't', organizationId: ORG, userId: 'u1' };
    expect(decide(check, { ...user, authorities: [`products:write#ORGANIZATION:${ORG}`] })).toBe(true);
    expect(decide(check, { ...user, authorities: [`products:write#ORGANIZATION:${OTHER}`] })).toBe(false);
    expect(decide(check, { ...user, authorities: ['products:write#TENANT'] })).toBe(true);
    expect(decide(check, { ...user, authorities: ['ROLE_ORGANIZATION_ADMIN'] })).toBe(true);
    expect(decide(check, { ...user, authorities: ['products:read'] })).toBe(false);
    expect(decide(check, { ...user, userId: null, authorities: ['products:write'] })).toBe(false);
    const audit = endpoint(artifact, 'GET /api/products/audit');
    expect(decide(audit, { ...user, authorities: ['ROLE_AUDITOR'] })).toBe(true);
    expect(decide(audit, { ...user, authorities: ['ROLE_ADMIN'] })).toBe(true);
    expect(decide(audit, { ...user, authorities: [] })).toBe(false);
  });
});
