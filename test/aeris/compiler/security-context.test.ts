import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

const PRINCIPAL = `
package demo.sec;
import java.util.UUID;
import org.springframework.security.authentication.AbstractAuthenticationToken;
public class AppUser extends AbstractAuthenticationToken {
  private UUID tenantId;
  private UUID userId;
  public AppUser() { super(null); }
  public UUID getTenantId() { return tenantId; }
  public UUID getUserId() { return userId; }
}
`;

const NOTE = `
package demo.sec;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Table(name = "note")
public class Note {
  @Id private UUID id;
  private UUID tenantId;
  private String tags;
  public UUID getId() { return id; }
  public UUID getTenantId() { return tenantId; }
  public String getTags() { return tags; }
}
`;

const REPO = `
package demo.sec;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface NoteRepository extends ReactiveCrudRepository<Note, UUID> {
  Flux<Note> findByTenantId(UUID tenantId);
}
`;

const CONTROLLER = `
package demo.sec;
import java.util.List;
import java.util.UUID;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/notes")
public class NoteController {
  private final NoteRepository repository;
  public NoteController(NoteRepository repository) { this.repository = repository; }

  @GetMapping("/tags")
  public Mono<List<String[]>> tags() {
    return ReactiveSecurityContextHolder.getContext()
      .map(SecurityContext::getAuthentication)
      .map(authentication -> (AppUser) authentication.getPrincipal())
      .map(AppUser::getTenantId)
      .flatMap(tenantId -> repository.findByTenantId(tenantId)
        .map(note -> note.getTags().split(","))
        .collectList());
  }
}
`;

const SOURCES = {
  'demo/sec/AppUser.java': PRINCIPAL,
  'demo/sec/Note.java': NOTE,
  'demo/sec/NoteRepository.java': REPO,
  'demo/sec/NoteController.java': CONTROLLER,
};

const CONFIG = {
  context: {
    sources: [{ method: 'RequestContextHolder.getRequiredContext', kind: 'required', type: 'demo.kernel.TenantContext' }],
    authentication: 'demo.sec.AppUser',
  },
  scopeClaims: { tenantId: ['tenantId'] },
};

/**
 * Spring Security's own reactive accessor. Any backend that does not hand the
 * session around itself reads it here, so refusing it refused the handler for a
 * reason that has nothing to do with what the handler computes.
 */
describe('ReactiveSecurityContextHolder', () => {
  it('binds the configured principal to the session claims, and the claims scope the read', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const plan = endpoint(artifact, 'GET /api/notes/tags');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const projection = artifact.projections.find((candidate) => candidate.table === 'note');
    expect(projection?.scope.map((entry) => entry.field)).toEqual(['tenantId']);
  });

  it('stays online when no principal class is configured, instead of inventing the session', async () => {
    const artifact = await compileJava(SOURCES, { ...CONFIG, context: { sources: CONFIG.context.sources } });
    expect(endpoint(artifact, 'GET /api/notes/tags').reasons.join(' ')).toMatch(/context\.authentication/);
  });

  it('splits a joined column exactly as String.split does, trailing empties included', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const rows = {
      'demo.sec.Note': [
        { id: '00000000-0000-4000-8000-000000000001', tenantId: 'aaaaaaaa-0000-4000-8000-000000000001', tags: 'red,green' },
        { id: '00000000-0000-4000-8000-000000000002', tenantId: 'aaaaaaaa-0000-4000-8000-000000000001', tags: 'blue,,' },
        { id: '00000000-0000-4000-8000-000000000003', tenantId: 'aaaaaaaa-0000-4000-8000-000000000001', tags: '' },
      ],
    };
    const result = await run(artifact, 'GET /api/notes/tags', rows, { context: { tenantId: 'aaaaaaaa-0000-4000-8000-000000000001' } });
    // "blue,," drops its trailing empties; "" never matches, so Java returns [""].
    expect(result.body).toEqual([['red', 'green'], ['blue'], ['']]);
  });
});
