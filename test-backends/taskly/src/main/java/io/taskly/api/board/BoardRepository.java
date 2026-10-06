package io.taskly.api.board;

import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface BoardRepository extends ReactiveCrudRepository<Board, UUID> {

    Flux<Board> findByWorkspaceIdOrderByNameAsc(UUID workspaceId);

    Flux<Board> findByWorkspaceIdAndArchived(UUID workspaceId, boolean archived);

    Mono<Long> countByWorkspaceId(UUID workspaceId);
}
