package io.taskly.jpa.idempotency;

public record StoredResponse(String key, int status, String body) {}
