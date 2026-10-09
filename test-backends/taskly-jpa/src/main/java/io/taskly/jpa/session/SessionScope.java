package io.taskly.jpa.session;

import java.util.Optional;
import java.util.UUID;

/**
 * The blocking counterpart of the reactive corpus's Reactor-Context holder: a
 * ThreadLocal a servlet filter fills. This is how a Spring MVC backend carries
 * the session, so it is how AERIS has to find it.
 */
public final class SessionScope {

    private static final ThreadLocal<CurrentUser> USER = new ThreadLocal<>();
    private static final ThreadLocal<CallInfo> CALL = new ThreadLocal<>();

    private SessionScope() {
    }

    static void open(CurrentUser user, CallInfo call) {
        if (user != null) {
            USER.set(user);
        }
        CALL.set(call);
    }

    static void close() {
        USER.remove();
        CALL.remove();
    }

    /** The caller, or an error: every scoped endpoint goes through here. */
    public static CurrentUser current() {
        CurrentUser user = USER.get();
        if (user == null) {
            throw new IllegalStateException("No session");
        }
        return user;
    }

    public static UUID currentWorkspaceId() {
        return current().workspaceId();
    }

    public static UUID currentMemberId() {
        return current().memberId();
    }

    public static Optional<CurrentUser> currentOrNone() {
        return Optional.ofNullable(USER.get());
    }

    public static Optional<CallInfo> callInfo() {
        return Optional.ofNullable(CALL.get());
    }
}
