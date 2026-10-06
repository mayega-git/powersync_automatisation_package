package io.taskly.api.board;

import java.time.Instant;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Version;
import org.springframework.data.relational.core.mapping.Table;

/**
 * A record cannot carry a transient "is new" flag, so the optimistic-lock
 * version decides: Spring Data treats a null version as an unsaved row.
 */
@Table(name = "board")
public record Board(@Id UUID id, @Version Long version, UUID workspaceId, UUID createdBy, String name,
        String colour, boolean archived, Instant createdAt) {

    public static Board create(UUID workspaceId, UUID createdBy, String name, String colour) {
        return new Board(UUID.randomUUID(), null, workspaceId, createdBy, name, colour, false, Instant.now());
    }

    public Board rename(String newName) {
        return new Board(id, version, workspaceId, createdBy, newName, colour, archived, createdAt);
    }

    public Board archive() {
        return new Board(id, version, workspaceId, createdBy, name, colour, true, createdAt);
    }
}
