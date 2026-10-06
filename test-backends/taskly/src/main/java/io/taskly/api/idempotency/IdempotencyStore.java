package io.taskly.api.idempotency;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
public class IdempotencyStore {

    private final DatabaseClient client;

    public IdempotencyStore(DatabaseClient client) {
        this.client = client;
    }

    public Mono<StoredResponse> find(String key) {
        return client.sql("SELECT key, status, body FROM idempotency_entry WHERE key = :key")
                .bind("key", key)
                .map((row, meta) -> new StoredResponse(row.get("key", String.class),
                        row.get("status", Integer.class), row.get("body", String.class)))
                .one();
    }

    public Mono<Void> remember(String key, int status, String body) {
        return client.sql("INSERT INTO idempotency_entry (key, status, body) VALUES (:key, :status, :body) ON CONFLICT (key) DO NOTHING")
                .bind("key", key).bind("status", status).bind("body", body)
                .then();
    }
}
