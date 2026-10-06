package io.taskly.api.audit;

import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

@Table(name = "activity_entry")
public record ActivityEntry(@Id UUID id, UUID workspaceId, UUID memberId, String action,
        UUID subjectId, String traceId, String callerIp) {}
