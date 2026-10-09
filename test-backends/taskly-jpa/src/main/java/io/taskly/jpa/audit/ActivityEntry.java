package io.taskly.jpa.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.util.UUID;

@Entity
@Table(name = "activity_entry")
public class ActivityEntry {

    @Id
    private UUID id;

    @Version
    private Long version;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "member_id", nullable = false)
    private UUID memberId;

    @Column(nullable = false)
    private String action;

    @Column(name = "subject_id")
    private UUID subjectId;

    @Column(name = "trace_id")
    private String traceId;

    @Column(name = "caller_ip")
    private String callerIp;

    protected ActivityEntry() {
    }

    public ActivityEntry(UUID workspaceId, UUID memberId, String action, UUID subjectId,
            String traceId, String callerIp) {
        this.id = UUID.randomUUID();
        this.workspaceId = workspaceId;
        this.memberId = memberId;
        this.action = action;
        this.subjectId = subjectId;
        this.traceId = traceId;
        this.callerIp = callerIp;
    }

    public UUID getId() {
        return id;
    }
}
