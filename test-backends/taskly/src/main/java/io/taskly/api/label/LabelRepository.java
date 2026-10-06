package io.taskly.api.label;

import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;

public interface LabelRepository extends ReactiveCrudRepository<Label, UUID> {
    Flux<Label> findAllByOrderByRankAsc();
}
