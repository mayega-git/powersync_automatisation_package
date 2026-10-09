package io.taskly.jpa.board;

import io.taskly.jpa.notify.MailNotifier;
import io.taskly.jpa.task.TaskService;
import java.util.List;
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
    public List<Board> list(@RequestParam(required = false) Boolean activeOnly) {
        return Boolean.TRUE.equals(activeOnly) ? boards.active() : boards.list();
    }

    @GetMapping("/{boardId}")
    public Board one(@PathVariable UUID boardId) {
        return boards.ofWorkspace(boardId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Board create(@RequestBody CreateBoard body) {
        return boards.create(body.name(), body.colour());
    }

    @PatchMapping("/{boardId}/name")
    public Board rename(@PathVariable UUID boardId, @RequestBody RenameBoard body) {
        return boards.rename(boardId, body.name());
    }

    @DeleteMapping("/{boardId}")
    public Board archive(@PathVariable UUID boardId) {
        return boards.archive(boardId);
    }

    @GetMapping("/count")
    public Map<String, Long> count() {
        return Map.of("boards", boards.count());
    }

    @GetMapping("/{boardId}/open-count")
    public Map<String, Long> openCount(@PathVariable UUID boardId) {
        return Map.of("open", tasks.openCount(boardId));
    }

    @PostMapping("/{boardId}/share")
    public String share(@PathVariable UUID boardId, @RequestParam String to) {
        Board board = boards.ofWorkspace(boardId);
        return mail.shareBoard(board.getId(), to);
    }
}
