package io.taskly.jpa.board;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BoardRepository extends JpaRepository<Board, UUID> {

    /** Names are not unique, so the key breaks the tie: without it no order is promised. */
    List<Board> findByWorkspaceIdOrderByNameAscIdAsc(UUID workspaceId);

    List<Board> findByWorkspaceIdAndArchived(UUID workspaceId, boolean archived);

    long countByWorkspaceId(UUID workspaceId);
}
