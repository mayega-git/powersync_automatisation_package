package io.taskly.api.task;

import java.time.Instant;
import java.util.UUID;
import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.domain.Persistable;
import org.springframework.data.relational.core.mapping.Table;

/** Identifiers are chosen here, so the row has to say whether it is new. */
@Data
@Builder(toBuilder = true)
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "task")
public class Task implements Persistable<UUID> {

    @Id
    private UUID id;
    private UUID boardId;
    private String title;
    private String state;
    private Integer position;
    private UUID assigneeId;
    private Instant createdAt;
    private Instant completedAt;

    @JsonIgnore
    @Transient
    @Builder.Default
    private boolean newEntity = true;

    @Override
    public UUID getId() {
        return id;
    }

    /** Persistence bookkeeping: never part of what the API answers. */
    @JsonIgnore
    @Override
    public boolean isNew() {
        return newEntity;
    }
}
