package io.taskly.api.board;

import io.taskly.api.notify.MailNotifier;
import io.taskly.api.task.TaskService;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
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
@RequestMapping("/api/boards")
public class BoardController {

    private final BoardService boards;
    private final TaskService tasks;
    private final MailNotifier mail;

    public BoardController(BoardService boards, TaskService tasks, MailNotifier mail) {
        this.boards = boards;
        this.tasks = tasks;
        this.mail = mail;
    }

    @GetMapping
    public Flux<Board> list(@RequestParam(required = false) Boolean activeOnly) {
        return Boolean.TRUE.equals(activeOnly) ? boards.active() : boards.list();
    }

    @GetMapping("/{boardId}")
    public Mono<Board> one(@PathVariable UUID boardId) {
        return boards.ofWorkspace(boardId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<Board> create(@RequestBody CreateBoard body) {
        return boards.create(body.name(), body.colour());
    }

    @PatchMapping("/{boardId}/name")
    public Mono<Board> rename(@PathVariable UUID boardId, @RequestBody RenameBoard body) {
        return boards.rename(boardId, body.name());
    }

    @DeleteMapping("/{boardId}")
    public Mono<Board> archive(@PathVariable UUID boardId) {
        return boards.archive(boardId);
    }

    @GetMapping("/count")
    public Mono<Map<String, Long>> count() {
        return boards.count().map(total -> Map.of("boards", total));
    }

    @GetMapping("/{boardId}/open-count")
    public Mono<Map<String, Long>> openCount(@PathVariable UUID boardId) {
        return tasks.openCount(boardId).map(open -> Map.of("open", open));
    }

    @PostMapping("/{boardId}/share")
    public Mono<String> share(@PathVariable UUID boardId, @RequestParam String to) {
        return boards.ofWorkspace(boardId).flatMap(board -> mail.shareBoard(board.id(), to));
    }
}
