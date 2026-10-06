package io.taskly.api.session;

import java.util.UUID;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

/**
 * Puts the caller in the Reactor Context. A real deployment would read a signed
 * token here; this corpus trusts headers, exactly like the Sync Gateway's
 * `trusted-headers` mode, so a test can state who is calling.
 */
@Component
public class SessionFilter implements WebFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        UUID workspaceId = uuid(request, "x-workspace-id");
        UUID memberId = uuid(request, "x-member-id");
        Context context = Context.empty();
        if (workspaceId != null && memberId != null) {
            String email = request.getHeaders().getFirst("x-member-email");
            context = SessionScope.withUser(context, new CurrentUser(workspaceId, memberId, email));
        }
        context = context.put(SessionScope.CALL_KEY, new CallInfo(
                request.getId(),
                request.getRemoteAddress() == null ? null : request.getRemoteAddress().getHostString(),
                request.getHeaders().getFirst("user-agent")));
        return chain.filter(exchange).contextWrite(context);
    }

    private static UUID uuid(ServerHttpRequest request, String header) {
        String raw = request.getHeaders().getFirst(header);
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
