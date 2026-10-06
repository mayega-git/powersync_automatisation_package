package io.taskly.api.session;

import java.util.UUID;

/** The signed-in member and the workspace they are acting in. */
public record CurrentUser(UUID workspaceId, UUID memberId, String email) {}
