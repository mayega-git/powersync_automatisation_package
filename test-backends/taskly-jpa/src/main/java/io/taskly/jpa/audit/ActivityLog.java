package io.taskly.jpa.audit;

import io.taskly.jpa.session.CallInfo;
import io.taskly.jpa.session.SessionScope;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** Keeps a trail of what happened, for support. Never part of an answer. */
@Component
public class ActivityLog {

    private final ActivityEntryRepository entries;

    public ActivityLog(ActivityEntryRepository entries) {
        this.entries = entries;
    }

    public void record(UUID workspaceId, UUID memberId, String action, UUID subjectId) {
        CallInfo call = SessionScope.callInfo().orElse(null);
        entries.save(new ActivityEntry(workspaceId, memberId, action, subjectId,
                call == null ? null : call.traceId(),
                call == null ? null : call.callerIp()));
    }
}
