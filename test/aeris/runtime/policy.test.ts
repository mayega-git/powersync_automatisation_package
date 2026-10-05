import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../../../src/aeris/runtime/policy.js';

const claims = { userId: 'u1', organizationId: 'o1', permissions: ['products:write', 'ROLE_ADMIN'], services: ['HRM', 'TREASURY'] };

describe('evaluatePolicy', () => {
  it('evaluates the Spring Security built-ins on cached claims', () => {
    expect(evaluatePolicy("hasAuthority('products:write')", claims)).toBe(true);
    expect(evaluatePolicy("hasAuthority('products:delete')", claims)).toBe(false);
    expect(evaluatePolicy("hasRole('ADMIN') and isAuthenticated()", claims)).toBe(true);
    expect(evaluatePolicy("hasAnyRole('USER', 'AUDITOR') or not hasAuthority('x')", claims)).toBe(true);
    expect(evaluatePolicy("claim('services').contains('TREASURY')", claims)).toBe(true);
    expect(evaluatePolicy("claim('services').contains('BANKING')", claims)).toBe(false);
  });

  it('delegates bean calls to the application and fails closed on anything unknown', () => {
    const beans = { businessAccessPolicy: { hasPermission: (auth: unknown, permission: unknown) => (auth as typeof claims).permissions.includes(permission as string) } };
    expect(evaluatePolicy("@businessAccessPolicy.hasPermission(authentication, 'products:write')", claims, beans as never)).toBe(true);
    expect(evaluatePolicy("@businessAccessPolicy.hasPermission(authentication, 'treasury:manage')", claims, beans as never)).toBe(false);
    expect(evaluatePolicy("@otherBean.check(authentication)", claims, beans as never)).toBeUndefined();
    expect(evaluatePolicy('hasPermission(#id, "Order", "read")', claims)).toBeUndefined();
    expect(evaluatePolicy("hasAuthority('a'", claims)).toBeUndefined();
  });
});
