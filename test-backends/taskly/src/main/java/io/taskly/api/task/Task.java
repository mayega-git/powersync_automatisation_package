package io.taskly.api.task;

import java.time.Instant;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

@Data
@Builder(toBuilder = true)
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "task")
public class Task {

    @Id
    private UUID id;
    private UUID boardId;
    private String title;
    private String state;
    private Integer position;
    private UUID assigneeId;
    private Instant createdAt;
    private Instant completedAt;
}
