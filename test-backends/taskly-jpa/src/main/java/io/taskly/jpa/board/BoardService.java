package io.taskly.jpa.board;

import io.taskly.jpa.audit.ActivityLog;
import io.taskly.jpa.session.CurrentUser;
import io.taskly.jpa.session.SessionScope;
import io.taskly.jpa.web.ConflictException;
import io.taskly.jpa.web.NotFoundException;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BoardService {

    private final BoardRepository boards;
    private final ActivityLog activity;

    public BoardService(BoardRepository boards, ActivityLog activity) {
        this.boards = boards;
        this.activity = activity;
    }

    @Transactional(readOnly = true)
    public List<Board> list() {
        return boards.findByWorkspaceIdOrderByNameAscIdAsc(SessionScope.currentWorkspaceId());
    }

    @Transactional(readOnly = true)
    public List<Board> active() {
        return boards.findByWorkspaceIdAndArchived(SessionScope.currentWorkspaceId(), false);
    }

    /** A board of the caller's workspace, or nothing. */
    @Transactional(readOnly = true)
    public Board ofWorkspace(UUID boardId) {
        return ofWorkspace(boardId, "No board " + boardId);
    }

    /**
     * The same lookup, raising the caller's own message. Reaching a board through
     * something it owns must not answer "no board X": that would tell whoever
     * asked that the row exists and belongs to a workspace they cannot see.
     */
    @Transactional(readOnly = true)
    public Board ofWorkspace(UUID boardId, String notFound) {
        UUID workspaceId = SessionScope.currentWorkspaceId();
        return boards.findById(boardId)
                .filter(board -> workspaceId.equals(board.getWorkspaceId()))
                .orElseThrow(() -> new NotFoundException(notFound));
    }

    @Transactional
    public Board create(String name, String colour) {
        CurrentUser user = SessionScope.current();
        Board board = Board.create(user.workspaceId(), user.memberId(), name.trim(),
                colour == null ? "slate" : colour);
        Board saved = boards.save(board);
        activity.record(user.workspaceId(), user.memberId(), "BOARD_CREATED", saved.getId());
        return saved;
    }

    @Transactional
    public Board rename(UUID boardId, String name) {
        Board board = ofWorkspace(boardId);
        board.setName(name.trim());
        return boards.save(board);
    }

    @Transactional
    public Board archive(UUID boardId) {
        Board board = ofWorkspace(boardId);
        if (board.isArchived()) {
            throw new ConflictException("Board already archived");
        }
        board.setArchived(true);
        return boards.save(board);
    }

    @Transactional(readOnly = true)
    public long count() {
        return boards.countByWorkspaceId(SessionScope.currentWorkspaceId());
    }
}
