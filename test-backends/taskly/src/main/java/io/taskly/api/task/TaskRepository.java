package io.taskly.api.task;

import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface TaskRepository extends ReactiveCrudRepository<Task, UUID> {

    Flux<Task> findByBoardIdOrderByPositionAsc(UUID boardId);

    Flux<Task> findByBoardIdAndState(UUID boardId, String state);

    Mono<Long> countByBoardIdAndState(UUID boardId, String state);
}
