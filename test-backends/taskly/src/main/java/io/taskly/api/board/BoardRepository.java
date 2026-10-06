package io.taskly.api.board;

import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface BoardRepository extends ReactiveCrudRepository<Board, UUID> {

    /** Names are not unique, so the key breaks the tie: without it no order is promised. */
    Flux<Board> findByWorkspaceIdOrderByNameAscIdAsc(UUID workspaceId);

    Flux<Board> findByWorkspaceIdAndArchived(UUID workspaceId, boolean archived);

    Mono<Long> countByWorkspaceId(UUID workspaceId);
}
