package io.taskly.jpa.label;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LabelRepository extends JpaRepository<Label, UUID> {
    List<Label> findAllByOrderByRankAsc();
}
