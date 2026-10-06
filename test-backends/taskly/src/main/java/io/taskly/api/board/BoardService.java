package io.taskly.api.board;

import io.taskly.api.audit.ActivityLog;
import io.taskly.api.session.CurrentUser;
import io.taskly.api.session.SessionScope;
import io.taskly.api.web.ConflictException;
import io.taskly.api.web.NotFoundException;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class BoardService {

    private final BoardRepository boards;
    private final ActivityLog activity;

    public BoardService(BoardRepository boards, ActivityLog activity) {
        this.boards = boards;
        this.activity = activity;
    }

    public Flux<Board> list() {
        return SessionScope.current().flatMapMany(user -> boards.findByWorkspaceIdOrderByNameAsc(user.workspaceId()));
    }

    public Flux<Board> active() {
        return SessionScope.current().flatMapMany(user -> boards.findByWorkspaceIdAndArchived(user.workspaceId(), false));
    }

    /** A board of the caller's workspace, or nothing. */
    public Mono<Board> ofWorkspace(UUID boardId) {
        return SessionScope.current().flatMap(user -> boards.findById(boardId)
                .filter(board -> user.workspaceId().equals(board.workspaceId()))
                .switchIfEmpty(Mono.error(new NotFoundException("No board " + boardId))));
    }

    public Mono<Board> create(String name, String colour) {
        return SessionScope.current().flatMap(user -> {
            Board board = Board.create(user.workspaceId(), user.memberId(), name.trim(),
                    colour == null ? "slate" : colour);
            return boards.save(board)
                    .flatMap(saved -> activity.record(user.workspaceId(), user.memberId(), "BOARD_CREATED", saved.id())
                            .thenReturn(saved));
        });
    }

    public Mono<Board> rename(UUID boardId, String name) {
        return ofWorkspace(boardId).flatMap(board -> boards.save(board.rename(name.trim())));
    }

    public Mono<Board> archive(UUID boardId) {
        return ofWorkspace(boardId).flatMap(board -> board.archived()
                ? Mono.error(new ConflictException("Board already archived"))
                : boards.save(board.archive()));
    }

    public Mono<Long> count() {
        return SessionScope.current().flatMap(user -> boards.countByWorkspaceId(user.workspaceId()));
    }
}
