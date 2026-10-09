package io.taskly.jpa.task;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface TaskRepository extends JpaRepository<Task, UUID> {

    List<Task> findByBoardIdOrderByPositionAscIdAsc(UUID boardId);

    List<Task> findByBoardIdAndState(UUID boardId, String state);

    long countByBoardIdAndState(UUID boardId, String state);
}
