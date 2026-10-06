package io.taskly.api.audit;

import io.taskly.api.session.CallInfo;
import io.taskly.api.session.SessionScope;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/** Keeps a trail of what happened, for support. Never part of an answer. */
@Component
public class ActivityLog {

    private final ActivityEntryRepository entries;

    public ActivityLog(ActivityEntryRepository entries) {
        this.entries = entries;
    }

    public Mono<Void> record(UUID workspaceId, UUID memberId, String action, UUID subjectId) {
        return SessionScope.callInfo().flatMap(maybeCall -> {
            CallInfo call = maybeCall.orElse(null);
            ActivityEntry entry = new ActivityEntry(UUID.randomUUID(), workspaceId, memberId, action,
                    subjectId, call == null ? null : call.traceId(), call == null ? null : call.callerIp());
            return entries.save(entry).then();
        });
    }
}
