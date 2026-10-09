package io.taskly.jpa.board;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/**
 * A JPA entity cannot be a record (the provider needs a no-arg constructor and
 * mutable state), so the shape differs from the reactive corpus even though the
 * API answers the same JSON.
 *
 * The @Version is what makes `save()` decidable: Spring Data JPA merges a
 * detached entity, which inserts or updates depending on the row, and a null
 * version is what says the row has never been written.
 */
@Entity
@Table(name = "board")
public class Board {

    @Id
    private UUID id;

    @Version
    private Long version;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "created_by", nullable = false)
    private UUID createdBy;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String colour;

    @Column(nullable = false)
    private boolean archived;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Board() {
    }

    public static Board create(UUID workspaceId, UUID createdBy, String name, String colour) {
        Board board = new Board();
        board.id = UUID.randomUUID();
        board.workspaceId = workspaceId;
        board.createdBy = createdBy;
        board.name = name;
        board.colour = colour;
        board.archived = false;
        board.createdAt = Instant.now();
        return board;
    }

    public UUID getId() {
        return id;
    }

    public Long getVersion() {
        return version;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getColour() {
        return colour;
    }

    public boolean isArchived() {
        return archived;
    }

    public void setArchived(boolean archived) {
        this.archived = archived;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
