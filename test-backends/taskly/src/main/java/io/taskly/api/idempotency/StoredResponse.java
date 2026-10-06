package io.taskly.api.idempotency;

public record StoredResponse(String key, int status, String body) {}
