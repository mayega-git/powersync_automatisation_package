package io.taskly.api.session;

import java.util.Optional;
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

public final class SessionScope {

    static final String USER_KEY = "taskly.user";
    static final String CALL_KEY = "taskly.call";

    private SessionScope() {
    }

    public static Context withUser(Context context, CurrentUser user) {
        return context.put(USER_KEY, user);
    }

    public static Mono<CurrentUser> current() {
        return Mono.deferContextual(ctx -> ctx.hasKey(USER_KEY)
                ? Mono.just(ctx.get(USER_KEY))
                : Mono.error(new IllegalStateException("No session")));
    }

    public static Mono<Optional<CurrentUser>> currentOrNone() {
        return Mono.deferContextual(ctx -> Mono.just(
                ctx.hasKey(USER_KEY) ? Optional.of((CurrentUser) ctx.get(USER_KEY)) : Optional.empty()));
    }

    public static Mono<Optional<CallInfo>> callInfo() {
        return Mono.deferContextual(ctx -> Mono.just(
                ctx.hasKey(CALL_KEY) ? Optional.of((CallInfo) ctx.get(CALL_KEY)) : Optional.empty()));
    }
}
