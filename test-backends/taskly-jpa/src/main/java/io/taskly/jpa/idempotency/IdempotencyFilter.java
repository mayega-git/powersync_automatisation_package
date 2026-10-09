package io.taskly.jpa.idempotency;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.Set;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

/**
 * Applies a mutation carrying an `Idempotency-Key` once. A replay of the same
 * key is answered from the stored response instead of being executed again,
 * which is what lets a creation be retried safely after a lost answer. Same
 * contract as the reactive corpus's WebFilter, written for the servlet stack.
 */
@Component
@Order(2)
public class IdempotencyFilter extends OncePerRequestFilter {

    public static final String HEADER = "Idempotency-Key";
    private static final Set<String> MUTATING = Set.of("POST", "PUT", "PATCH", "DELETE");

    private final IdempotencyStore store;

    public IdempotencyFilter(IdempotencyStore store) {
        this.store = store;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String key = request.getHeader(HEADER);
        boolean covered = key != null && !key.isBlank()
                && MUTATING.contains(request.getMethod())
                && request.getRequestURI().startsWith("/api/");
        if (!covered) {
            chain.doFilter(request, response);
            return;
        }
        Optional<StoredResponse> stored = store.find(key);
        if (stored.isPresent()) {
            replay(response, stored.get());
            return;
        }
        ContentCachingResponseWrapper captured = new ContentCachingResponseWrapper(response);
        chain.doFilter(request, captured);
        byte[] body = captured.getContentAsByteArray();
        int status = captured.getStatus();
        captured.copyBodyToResponse();
        // Only a success is worth replaying: a failure must be retryable.
        if (status >= 200 && status < 300) {
            store.remember(key, status, new String(body, StandardCharsets.UTF_8));
        }
    }

    private void replay(HttpServletResponse response, StoredResponse stored) throws IOException {
        response.setStatus(stored.status());
        if (stored.body() == null || stored.body().isEmpty()) {
            return;
        }
        response.setContentType("application/json");
        response.getOutputStream().write(stored.body().getBytes(StandardCharsets.UTF_8));
    }
}
