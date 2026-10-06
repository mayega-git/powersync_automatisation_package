package io.taskly.api.idempotency;

import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.reactivestreams.Publisher;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Applies a mutation carrying an `Idempotency-Key` once. A replay of the same
 * key is answered from the stored response instead of being executed again,
 * which is what lets a creation be retried safely after a lost answer.
 */
@Component
public class IdempotencyFilter implements WebFilter {

    public static final String HEADER = "Idempotency-Key";
    private static final Set<HttpMethod> MUTATING = Set.of(HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE);

    private final IdempotencyStore store;

    public IdempotencyFilter(IdempotencyStore store) {
        this.store = store;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String key = exchange.getRequest().getHeaders().getFirst(HEADER);
        boolean covered = key != null && !key.isBlank()
                && MUTATING.contains(exchange.getRequest().getMethod())
                && exchange.getRequest().getPath().value().startsWith("/api/");
        if (!covered) {
            return chain.filter(exchange);
        }
        return store.find(key)
                .flatMap(stored -> replay(exchange, stored))
                .switchIfEmpty(Mono.defer(() -> chain.filter(exchange.mutate().response(capture(exchange, key)).build())));
    }

    private Mono<Void> replay(ServerWebExchange exchange, StoredResponse stored) {
        ServerHttpResponse response = exchange.getResponse();
        response.setStatusCode(HttpStatus.valueOf(stored.status()));
        if (stored.body() == null || stored.body().isEmpty()) {
            return response.setComplete();
        }
        response.getHeaders().set("content-type", "application/json");
        DataBuffer buffer = response.bufferFactory().wrap(stored.body().getBytes(StandardCharsets.UTF_8));
        return response.writeWith(Mono.just(buffer));
    }

    /** Remembers the answer as it goes out, so the next replay can repeat it. */
    private ServerHttpResponse capture(ServerWebExchange exchange, String key) {
        return new ServerHttpResponseDecorator(exchange.getResponse()) {
            @Override
            public Mono<Void> writeWith(Publisher<? extends DataBuffer> body) {
                return DataBufferUtils.join(Flux.from(body)).flatMap(joined -> {
                    byte[] bytes = new byte[joined.readableByteCount()];
                    joined.read(bytes);
                    DataBufferUtils.release(joined);
                    int status = getStatusCode() == null ? 200 : getStatusCode().value();
                    String text = new String(bytes, StandardCharsets.UTF_8);
                    Mono<Void> remembered = status < 500
                            ? store.remember(key, status, text).onErrorResume(failure -> Mono.empty())
                            : Mono.empty();
                    return remembered.then(super.writeWith(Mono.just(bufferFactory().wrap(bytes))));
                });
            }

            @Override
            public Mono<Void> writeAndFlushWith(Publisher<? extends Publisher<? extends DataBuffer>> body) {
                return writeWith(Flux.from(body).flatMap(inner -> inner));
            }

            @Override
            public Mono<Void> setComplete() {
                int status = getStatusCode() == null ? 200 : getStatusCode().value();
                Mono<Void> remembered = status < 500
                        ? store.remember(key, status, "").onErrorResume(failure -> Mono.empty())
                        : Mono.empty();
                return remembered.then(super.setComplete());
            }
        };
    }
}
