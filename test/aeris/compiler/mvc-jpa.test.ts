import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

/**
 * The other Spring stack: MVC handlers (no publisher) over JPA repositories
 * (blocking, Optional/List). Nothing about a query changes between the two --
 * the same rows, filters and order -- so the compiler proves it once and only
 * the wrapper differs. These tests hold that line: the same containment proof,
 * the same classes, and the same answers as the reactive corpus would give.
 */
const CONTEXT = `
package demo.mvc;
import java.util.UUID;
public final class MvcContext {
  private static final ThreadLocal<UUID> tenant = new ThreadLocal<>();
  private MvcContext() {}
  public static void setTenantId(UUID value) { tenant.set(value); }
  public static UUID currentTenantId() { return tenant.get(); }
}
`;

const ENTITY = `
package demo.mvc;
import java.util.UUID;
import jakarta.persistence.*;
@Entity
@Table(name = "note")
public class Note {
  @Id private UUID id;
  /** Null until the row has been written: what tells an insert from an update. */
  @Version private Long version;
  @Column(name = "tenant_id") private UUID tenantId;
  private String title;
  private boolean archived;
  public UUID getId() { return id; }
  public void setId(UUID id) { this.id = id; }
  public Long getVersion() { return version; }
  public void setVersion(Long version) { this.version = version; }
  public UUID getTenantId() { return tenantId; }
  public void setTenantId(UUID tenantId) { this.tenantId = tenantId; }
  public String getTitle() { return title; }
  public void setTitle(String title) { this.title = title; }
  public boolean isArchived() { return archived; }
  public void setArchived(boolean archived) { this.archived = archived; }
}
`;

/** A Long key the database assigns: provably not choosable offline. */
const GENERATED = `
package demo.mvc;
import jakarta.persistence.*;
@Entity
@Table(name = "ticket")
public class Ticket {
  @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;
  @Version private Long version;
  @Column(name = "tenant_id") private java.util.UUID tenantId;
  private String label;
  public Long getId() { return id; }
  public Long getVersion() { return version; }
  public void setVersion(Long version) { this.version = version; }
  public java.util.UUID getTenantId() { return tenantId; }
  public void setTenantId(java.util.UUID tenantId) { this.tenantId = tenantId; }
  public String getLabel() { return label; }
  public void setLabel(String label) { this.label = label; }
}
`;

const REPOSITORIES = `
package demo.mvc;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
public interface NoteRepository extends JpaRepository<Note, UUID> {
  List<Note> findByTenantIdOrderByTitleAsc(UUID tenantId);
  List<Note> findByTenantIdAndArchived(UUID tenantId, boolean archived);
}
`;

/** An assigned key, no @Version, no Persistable: save() is a merge of unknown shape. */
const AMBIGUOUS = `
package demo.mvc;
import java.util.UUID;
import jakarta.persistence.*;
@Entity
@Table(name = "memo")
public class Memo {
  @Id private UUID id;
  @Column(name = "tenant_id") private UUID tenantId;
  private String body;
  public UUID getId() { return id; }
  public void setId(UUID id) { this.id = id; }
  public UUID getTenantId() { return tenantId; }
  public void setTenantId(UUID tenantId) { this.tenantId = tenantId; }
  public String getBody() { return body; }
  public void setBody(String body) { this.body = body; }
}
`;

const AMBIGUOUS_REPOSITORY = `
package demo.mvc;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
public interface MemoRepository extends JpaRepository<Memo, UUID> {}
`;

const AMBIGUOUS_CONTROLLER = `
package demo.mvc;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/memos")
public class MemoController {
  private final MemoRepository repository;
  public MemoController(MemoRepository repository) { this.repository = repository; }

  @PostMapping
  public Memo create(@RequestBody CreateNote request) {
    Memo memo = new Memo();
    memo.setId(UUID.randomUUID());
    memo.setTenantId(MvcContext.currentTenantId());
    memo.setBody(request.title());
    return repository.save(memo);
  }
}
`;

const TICKET_REPOSITORY = `
package demo.mvc;
import org.springframework.data.jpa.repository.JpaRepository;
public interface TicketRepository extends JpaRepository<Ticket, Long> {
}
`;

const REQUEST = `
package demo.mvc;
public record CreateNote(String title) {}
`;

const CONTROLLER = `
package demo.mvc;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/notes")
public class NoteController {
  private final NoteRepository repository;
  public NoteController(NoteRepository repository) { this.repository = repository; }

  @GetMapping
  public List<Note> list() {
    return repository.findByTenantIdOrderByTitleAsc(MvcContext.currentTenantId());
  }

  @GetMapping("/{id}")
  public ResponseEntity<Note> byId(@PathVariable UUID id) {
    UUID tenantId = MvcContext.currentTenantId();
    return repository.findById(id)
        .filter(note -> note.getTenantId().equals(tenantId))
        .map(ResponseEntity::ok)
        .orElseGet(() -> ResponseEntity.notFound().build());
  }

  @GetMapping("/open-count")
  public long openCount() {
    return repository.findByTenantIdAndArchived(MvcContext.currentTenantId(), false).size();
  }

  @PostMapping
  public ResponseEntity<Note> create(@RequestBody CreateNote request) {
    Note note = new Note();
    note.setTenantId(MvcContext.currentTenantId());
    note.setTitle(request.title());
    note.setArchived(false);
    return ResponseEntity.status(201).body(repository.save(note));
  }

  @PutMapping("/{id}/archive")
  public ResponseEntity<Note> archive(@PathVariable UUID id) {
    UUID tenantId = MvcContext.currentTenantId();
    return repository.findById(id)
        .filter(note -> note.getTenantId().equals(tenantId))
        .map(note -> { note.setArchived(true); return ResponseEntity.ok(repository.save(note)); })
        .orElseGet(() -> ResponseEntity.notFound().build());
  }
}
`;

const TICKET_CONTROLLER = `
package demo.mvc;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/tickets")
public class TicketController {
  private final TicketRepository repository;
  public TicketController(TicketRepository repository) { this.repository = repository; }

  @PostMapping
  public Ticket create(@RequestBody CreateNote request) {
    Ticket ticket = new Ticket();
    ticket.setTenantId(MvcContext.currentTenantId());
    ticket.setLabel(request.title());
    return repository.save(ticket);
  }
}
`;

const SOURCES = {
  'demo/mvc/MvcContext.java': CONTEXT,
  'demo/mvc/Note.java': ENTITY,
  'demo/mvc/NoteRepository.java': REPOSITORIES,
  'demo/mvc/CreateNote.java': REQUEST,
  'demo/mvc/NoteController.java': CONTROLLER,
};

const CONFIG = {
  context: { sources: [{ method: 'MvcContext.currentTenantId', kind: 'claim', claim: 'tenantId' }] },
  scopeClaims: { tenantId: ['tenantId'] },
  idempotency: { header: 'Idempotency-Key', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], paths: ['/api/**'] },
};

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const note = (n: number, tenantId: string, title: string, archived = false) => ({
  id: id(n), version: 1, tenantId, title, archived,
});

describe('Spring MVC over JPA', () => {
  it('classifies blocking reads and writes exactly as the reactive stack does', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const classes = Object.fromEntries(artifact.endpoints.map((plan) => [plan.id, plan.offlineClass]));
    expect(classes, JSON.stringify(artifact.endpoints.map((plan) => [plan.id, plan.reasons]))).toEqual({
      'GET /api/notes': 'LOCAL_READ_SAFE',
      'GET /api/notes/{id}': 'LOCAL_READ_SAFE',
      'GET /api/notes/open-count': 'LOCAL_READ_SAFE',
      'POST /api/notes': 'REPLAYABLE',
      'PUT /api/notes/{id}/archive': 'SPECULATIVE',
    });
  });

  it('projects the JPA entity under its @Column names, scoped by the session claim', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const projection = artifact.projections.find((candidate) => candidate.table === 'note');
    expect(projection?.scope.map((entry) => entry.field)).toEqual(['tenantId']);
    expect(projection?.columns.find((column) => column.name === 'tenantId')?.column).toBe('tenant_id');
  });

  it('answers a derived List query in the order the method name asks for', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const rows = {
      'demo.mvc.Note': [note(1, TENANT, 'Zeta'), note(2, TENANT, 'Alpha'), note(3, OTHER, 'Hidden')],
    };
    const result = await run(artifact, 'GET /api/notes', rows, { context: { tenantId: TENANT } });
    expect(result.status).toBe(200);
    expect((result.body as { title: string }[]).map((row) => row.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('turns findById into an Optional: present answers 200, absent answers 404', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const rows = { 'demo.mvc.Note': [note(1, TENANT, 'Mine'), note(3, OTHER, 'Theirs')] };
    const mine = await run(artifact, 'GET /api/notes/{id}', rows, { params: { id: id(1) }, context: { tenantId: TENANT } });
    expect(mine.status).toBe(200);
    expect((mine.body as { title: string }).title).toBe('Mine');
    // Another tenant's row exists but is outside the projection: 404, never its content.
    const theirs = await run(artifact, 'GET /api/notes/{id}', rows, { params: { id: id(3) }, context: { tenantId: TENANT } });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toBeNull();
  });

  it('counts through List.size() on a derived query', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const rows = {
      'demo.mvc.Note': [note(1, TENANT, 'A'), note(2, TENANT, 'B', true), note(3, OTHER, 'C')],
    };
    const result = await run(artifact, 'GET /api/notes/open-count', rows, { context: { tenantId: TENANT } });
    expect(result.body).toBe(1);
  });

  it('inserts through save() and answers the stored row', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const result = await run(artifact, 'POST /api/notes', {}, { body: { title: 'Fresh' }, context: { tenantId: TENANT } });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ title: 'Fresh', archived: false, tenantId: TENANT });
  });

  it('updates through save() of a row it has just read', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const rows = { 'demo.mvc.Note': [note(1, TENANT, 'Mine')] };
    const result = await run(artifact, 'PUT /api/notes/{id}/archive', rows, { params: { id: id(1) }, context: { tenantId: TENANT } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ title: 'Mine', archived: true });
  });

  /**
   * JPA's save() of a detached entity is a merge -- it inserts when no row has
   * that key and updates when one does -- while R2DBC's is an update decided by
   * a null id or version. With an assigned key and nothing to tell the cases
   * apart, reproducing one of them would be a guess.
   */
  it('refuses a save() whose insert-or-update it cannot decide', async () => {
    const artifact = await compileJava({
      ...SOURCES,
      'demo/mvc/Memo.java': AMBIGUOUS,
      'demo/mvc/MemoRepository.java': AMBIGUOUS_REPOSITORY,
      'demo/mvc/MemoController.java': AMBIGUOUS_CONTROLLER,
    }, CONFIG);
    const plan = endpoint(artifact, 'POST /api/memos');
    expect(plan.offlineClass).toBe('UNSUPPORTED');
    expect(plan.reasons.join(' ')).toMatch(/neither @Version nor Persistable/);
  });

  /**
   * The one thing JPA adds that R2DBC does not: a key the database assigns.
   * A device cannot choose the next value of an identity column, so the write
   * cannot be performed locally -- and saying so is the whole point.
   */
  it('refuses to invent a database-assigned numeric key', async () => {
    const artifact = await compileJava({
      ...SOURCES,
      'demo/mvc/Ticket.java': GENERATED,
      'demo/mvc/TicketRepository.java': TICKET_REPOSITORY,
      'demo/mvc/TicketController.java': TICKET_CONTROLLER,
    }, CONFIG);
    const plan = endpoint(artifact, 'POST /api/tickets');
    expect(plan.offlineClass).toBe('UNSUPPORTED');
    expect(plan.reasons.join(' ')).toMatch(/database-generated integer key/);
  });
});
