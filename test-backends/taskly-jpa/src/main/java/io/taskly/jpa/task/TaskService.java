package io.taskly.jpa.task;

import io.taskly.jpa.audit.ActivityLog;
import io.taskly.jpa.board.BoardService;
import io.taskly.jpa.session.CurrentUser;
import io.taskly.jpa.session.SessionScope;
import io.taskly.jpa.web.ConflictException;
import io.taskly.jpa.web.NotFoundException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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

    @Transactional(readOnly = true)
    public List<Task> onBoard(UUID boardId) {
        boards.ofWorkspace(boardId);
        return tasks.findByBoardIdOrderByPositionAscIdAsc(boardId);
    }

    @Transactional(readOnly = true)
    public List<Task> onBoardWithState(UUID boardId, String state) {
        boards.ofWorkspace(boardId);
        return tasks.findByBoardIdAndState(boardId, state);
    }

    /**
     * A task reached by its own key: its board decides whether the caller may see
     * it. Both ways of failing answer the same thing, so the reply never reveals
     * that a task exists on a board the caller has no access to.
     */
    @Transactional(readOnly = true)
    public Task byId(UUID taskId) {
        String notFound = "No task " + taskId;
        Task task = tasks.findById(taskId).orElseThrow(() -> new NotFoundException(notFound));
        boards.ofWorkspace(task.getBoardId(), notFound);
        return task;
    }

    @Transactional
    public Task add(UUID boardId, String title, Integer position) {
        boards.ofWorkspace(boardId);
        CurrentUser user = SessionScope.current();
        Task saved = tasks.save(Task.open(boardId, title.trim(), position));
        activity.record(user.workspaceId(), user.memberId(), "TASK_ADDED", saved.getId());
        return saved;
    }

    @Transactional
    public Task complete(UUID taskId) {
        Task task = byId(taskId);
        if ("DONE".equals(task.getState())) {
            throw new ConflictException("Task already done");
        }
        task.setState("DONE");
        task.setCompletedAt(Instant.now());
        return tasks.save(task);
    }

    @Transactional
    public void remove(UUID taskId) {
        Task task = byId(taskId);
        tasks.deleteById(task.getId());
    }

    @Transactional(readOnly = true)
    public long openCount(UUID boardId) {
        boards.ofWorkspace(boardId);
        return tasks.countByBoardIdAndState(boardId, "OPEN");
    }
}
