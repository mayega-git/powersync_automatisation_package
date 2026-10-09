package io.taskly.jpa.audit;

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ActivityEntryRepository extends JpaRepository<ActivityEntry, UUID> {}
