package io.taskly.jpa.session;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.UUID;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Puts the caller in the ThreadLocal holder. A real deployment would read a
 * signed token here; this corpus trusts headers, exactly like the Sync
 * Gateway's `trusted-headers` mode, so a test can state who is calling.
 */
@Component
@Order(1)
public class SessionFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest http = (HttpServletRequest) request;
        UUID workspaceId = uuid(http.getHeader("x-workspace-id"));
        UUID memberId = uuid(http.getHeader("x-member-id"));
        CurrentUser user = workspaceId == null || memberId == null
                ? null
                : new CurrentUser(workspaceId, memberId, http.getHeader("x-member-email"));
        CallInfo call = new CallInfo(http.getHeader("x-request-id"), http.getRemoteAddr(), http.getHeader("user-agent"));
        try {
            SessionScope.open(user, call);
            chain.doFilter(request, response);
        } finally {
            SessionScope.close();
        }
    }

    private static UUID uuid(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException malformed) {
            return null;
        }
    }
}
