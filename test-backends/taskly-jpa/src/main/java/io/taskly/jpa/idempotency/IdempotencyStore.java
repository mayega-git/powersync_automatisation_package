package io.taskly.jpa.idempotency;

import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
public class IdempotencyStore {

    private final JdbcClient client;

    public IdempotencyStore(JdbcClient client) {
        this.client = client;
    }

    public Optional<StoredResponse> find(String key) {
        return client.sql("SELECT key, status, body FROM idempotency_entry WHERE key = :key")
                .param("key", key)
                .query((rs, rowNum) -> new StoredResponse(rs.getString("key"), rs.getInt("status"), rs.getString("body")))
                .optional();
    }

    public void remember(String key, int status, String body) {
        client.sql("INSERT INTO idempotency_entry (key, status, body) VALUES (:key, :status, :body) ON CONFLICT (key) DO NOTHING")
                .param("key", key)
                .param("status", status)
                .param("body", body)
                .update();
    }
}
