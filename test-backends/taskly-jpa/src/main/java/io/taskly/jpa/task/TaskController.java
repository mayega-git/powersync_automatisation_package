package io.taskly.jpa.task;

import io.taskly.jpa.session.CurrentUser;
import io.taskly.jpa.session.SessionScope;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class TaskController {

    private final TaskService tasks;

    public TaskController(TaskService tasks) {
        this.tasks = tasks;
    }

    @GetMapping("/boards/{boardId}/tasks")
    public List<Task> onBoard(@PathVariable UUID boardId, @RequestParam(required = false) String state) {
        return state == null ? tasks.onBoard(boardId) : tasks.onBoardWithState(boardId, state);
    }

    @PostMapping("/boards/{boardId}/tasks")
    @ResponseStatus(HttpStatus.CREATED)
    public Task add(@PathVariable UUID boardId, @RequestBody CreateTask body) {
        return tasks.add(boardId, body.title(), body.position());
    }

    @GetMapping("/tasks/{taskId}")
    public Task one(@PathVariable UUID taskId) {
        return tasks.byId(taskId);
    }

    @PostMapping("/tasks/{taskId}/complete")
    public Task complete(@PathVariable UUID taskId) {
        return tasks.complete(taskId);
    }

    @DeleteMapping("/tasks/{taskId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void remove(@PathVariable UUID taskId) {
        tasks.remove(taskId);
    }

    @GetMapping("/me")
    public CurrentUser me() {
        return SessionScope.current();
    }
}
