package io.taskly.api.board;

import java.time.Instant;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

@Table(name = "board")
public record Board(@Id UUID id, UUID workspaceId, UUID createdBy, String name, String colour,
        boolean archived, Instant createdAt) {

    public Board rename(String newName) {
        return new Board(id, workspaceId, createdBy, newName, colour, archived, createdAt);
    }

    public Board archive() {
        return new Board(id, workspaceId, createdBy, name, colour, true, createdAt);
    }
}
