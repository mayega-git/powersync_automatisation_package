package io.taskly.api.task;

import io.taskly.api.session.CurrentUser;
import io.taskly.api.session.SessionScope;
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
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api")
public class TaskController {

    private final TaskService tasks;

    public TaskController(TaskService tasks) {
        this.tasks = tasks;
    }

    @GetMapping("/boards/{boardId}/tasks")
    public Flux<Task> onBoard(@PathVariable UUID boardId, @RequestParam(required = false) String state) {
        return state == null ? tasks.onBoard(boardId) : tasks.onBoardWithState(boardId, state);
    }

    @PostMapping("/boards/{boardId}/tasks")
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<Task> add(@PathVariable UUID boardId, @RequestBody CreateTask body) {
        return tasks.add(boardId, body.title(), body.position());
    }

    @GetMapping("/tasks/{taskId}")
    public Mono<Task> one(@PathVariable UUID taskId) {
        return tasks.byId(taskId);
    }

    @PostMapping("/tasks/{taskId}/complete")
    public Mono<Task> complete(@PathVariable UUID taskId) {
        return tasks.complete(taskId);
    }

    @DeleteMapping("/tasks/{taskId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public Mono<Void> remove(@PathVariable UUID taskId) {
        return tasks.remove(taskId);
    }

    @GetMapping("/me")
    public Mono<CurrentUser> me() {
        return SessionScope.current();
    }
}
