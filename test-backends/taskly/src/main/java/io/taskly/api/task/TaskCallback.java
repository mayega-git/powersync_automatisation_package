package io.taskly.api.task;

import org.reactivestreams.Publisher;
import org.springframework.data.r2dbc.mapping.event.AfterConvertCallback;
import org.springframework.data.relational.core.sql.SqlIdentifier;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/** A row that came back from the database is not new. */
@Component
public class TaskCallback implements AfterConvertCallback<Task> {

    @Override
    public Publisher<Task> onAfterConvert(Task entity, SqlIdentifier table) {
        entity.setNewEntity(false);
        return Mono.just(entity);
    }
}
