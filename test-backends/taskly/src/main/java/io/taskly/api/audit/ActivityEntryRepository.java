package io.taskly.api.audit;

import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;

public interface ActivityEntryRepository extends ReactiveCrudRepository<ActivityEntry, UUID> {}
