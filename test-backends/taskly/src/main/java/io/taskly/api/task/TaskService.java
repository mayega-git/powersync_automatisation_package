package io.taskly.api.task;

import io.taskly.api.audit.ActivityLog;
import io.taskly.api.board.Board;
import io.taskly.api.board.BoardService;
import io.taskly.api.session.SessionScope;
import io.taskly.api.web.ConflictException;
import io.taskly.api.web.NotFoundException;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class TaskService {

    private final TaskRepository tasks;
    private final BoardService boards;
    private final ActivityLog activity;

    public TaskService(TaskRepository tasks, BoardService boards, ActivityLog activity) {
        this.tasks = tasks;
        this.boards = boards;
        this.activity = activity;
    }

    public Flux<Task> onBoard(UUID boardId) {
        return boards.ofWorkspace(boardId).flatMapMany(board -> tasks.findByBoardIdOrderByPositionAsc(boardId));
    }

    public Flux<Task> onBoardWithState(UUID boardId, String state) {
        return boards.ofWorkspace(boardId).flatMapMany(board -> tasks.findByBoardIdAndState(boardId, state));
    }

    /** A task reached by its own key: its board decides whether the caller may see it. */
    public Mono<Task> byId(UUID taskId) {
        return tasks.findById(taskId)
                .switchIfEmpty(Mono.error(new NotFoundException("No task " + taskId)))
                .flatMap(task -> boards.ofWorkspace(task.getBoardId()).thenReturn(task));
    }

    public Mono<Task> add(UUID boardId, String title, Integer position) {
        return boards.ofWorkspace(boardId).flatMap(board -> SessionScope.current().flatMap(user -> {
            Task task = Task.builder()
                    .id(UUID.randomUUID())
                    .boardId(boardId)
                    .title(title.trim())
                    .state("OPEN")
                    .position(position == null ? 0 : position)
                    .createdAt(Instant.now())
                    .build();
            return tasks.save(task)
                    .flatMap(saved -> activity.record(user.workspaceId(), user.memberId(), "TASK_ADDED", saved.getId())
                            .thenReturn(saved));
        }));
    }

    public Mono<Task> complete(UUID taskId) {
        return byId(taskId).flatMap(task -> {
            if ("DONE".equals(task.getState())) {
                return Mono.error(new ConflictException("Task already done"));
            }
            return tasks.save(task.toBuilder().state("DONE").completedAt(Instant.now()).build());
        });
    }

    public Mono<Void> remove(UUID taskId) {
        return byId(taskId).flatMap(task -> tasks.deleteById(task.getId()));
    }

    public Mono<Long> openCount(UUID boardId) {
        return boards.ofWorkspace(boardId).flatMap(board -> tasks.countByBoardIdAndState(boardId, "OPEN"));
    }
}
