package io.taskly.api.session;

/** Identifies the call, not the caller: filled by the edge, never by a device. */
public record CallInfo(String traceId, String callerIp, String userAgent) {}
