import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

/**
 * Request metadata a device does not have, reached through a holder whose body
 * reads the Reactor Context — unanalyzable on purpose, so these tests fail
 * unless the configured `metadata` source short-circuits it.
 */
const METADATA = `
package demo.obs;
public record RequestMetadata(String requestId, String remoteIp) {}
`;

const HOLDER = `
package demo.obs;
import java.util.Optional;
import reactor.core.publisher.Mono;
public final class MetadataHolder {
  private MetadataHolder() {}
  public static Mono<Optional<RequestMetadata>> getMetadata() {
    return Mono.deferContextual(ctx -> Mono.just(
        ctx.hasKey("metadata") ? Optional.of((RequestMetadata) ctx.get("metadata")) : Optional.empty()));
  }
}
`;

/** Server-side bookkeeping: returns nothing, and dereferences the metadata. */
const SINK = `
package demo.obs;
import java.util.Optional;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
@Service
public class AuditSink {
  public Mono<Void> record(String action, Optional<RequestMetadata> metadata) {
    String ip = metadata.map(RequestMetadata::remoteIp).orElse(null);
    System.out.println(action + ip);
    return Mono.empty();
  }
}
`;

/** Same shape, but it answers something: declaring it inert must be refused. */
const TALKING_SINK = `
package demo.obs;
import java.util.Optional;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
@Service
public class TalkingSink {
  public Mono<String> describe(Optional<RequestMetadata> metadata) {
    return Mono.just(metadata.map(RequestMetadata::requestId).orElse("none"));
  }
}
`;

const ENTITY = `
package demo.notes;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "note")
public class Note {
  @Id private UUID id;
  private UUID organizationId;
  private String label;
}
`;

const REPOSITORY = `
package demo.notes;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface NoteRepository extends ReactiveCrudRepository<Note, UUID> {
  Flux<Note> findByOrganizationId(UUID organizationId);
}
`;

/** Reads the metadata and hands it straight to the sink, never looking inside. */
const CONTROLLER = `
package demo.notes;
import demo.kernel.RequestContextHolder;
import demo.obs.AuditSink;
import demo.obs.MetadataHolder;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/notes")
public class NoteController {
  private final NoteRepository notes;
  private final AuditSink audit;
  public NoteController(NoteRepository notes, AuditSink audit) {
    this.notes = notes;
    this.audit = audit;
  }

  @GetMapping public Flux<Note> mine() {
    return RequestContextHolder.getRequiredContext().flatMapMany(ctx -> notes.findByOrganizationId(ctx.organizationId()));
  }

  @PostMapping public Mono<Note> create(@RequestBody Note body) {
    return Mono.zip(RequestContextHolder.getRequiredContext(), MetadataHolder.getMetadata())
        .flatMap(tuple -> notes.save(Note.builder()
                .id(UUID.randomUUID())
                .organizationId(tuple.getT1().organizationId())
                .label(body.getLabel())
                .build())
            .flatMap(saved -> audit.record("NOTE_CREATED", tuple.getT2()).thenReturn(saved)));
  }
}
`;

/** Looks inside the metadata itself: the answer would depend on it. */
const LEAKING_CONTROLLER = `
package demo.notes;
import demo.obs.MetadataHolder;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/leak")
public class LeakController {
  @GetMapping("/ip") public Mono<String> ip() {
    return MetadataHolder.getMetadata().map(metadata -> metadata.map(m -> m.remoteIp()).orElse("none"));
  }
}
`;

const TALKING_CONTROLLER = `
package demo.notes;
import demo.obs.MetadataHolder;
import demo.obs.TalkingSink;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/talking")
public class TalkingController {
  private final TalkingSink sink;
  public TalkingController(TalkingSink sink) { this.sink = sink; }
  @GetMapping("/describe") public Mono<String> describe() {
    return MetadataHolder.getMetadata().flatMap(sink::describe);
  }
}
`;

const SOURCES = {
  'demo/obs/RequestMetadata.java': METADATA,
  'demo/obs/MetadataHolder.java': HOLDER,
  'demo/obs/AuditSink.java': SINK,
  'demo/notes/Note.java': ENTITY,
  'demo/notes/NoteRepository.java': REPOSITORY,
  'demo/notes/NoteController.java': CONTROLLER,
};

const CONFIG = {
  context: {
    sources: [
      { method: 'RequestContextHolder.getRequiredContext', kind: 'required', type: 'demo.kernel.TenantContext' },
      { method: 'MetadataHolder.getMetadata', kind: 'metadata', type: 'demo.obs.RequestMetadata' },
    ],
  },
  inertEffects: ['AuditSink.record'],
};

const ORG = '11111111-1111-4111-8111-111111111111';
/** The identifier the test helper feeds to the program's first uuid slot. */
const GENERATED = '00000000-0000-4000-8000-000000000001';

describe('inert server-side effects and request metadata', () => {
  it('compiles a handler that forwards metadata to an inert sink', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const plan = endpoint(artifact, 'POST /api/notes');
    expect(plan.offlineClass).not.toBe('UNSUPPORTED');
    expect(plan.unresolved).toEqual([]);
  });

  it('records every skipped call as evidence a reviewer can audit', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const inert = endpoint(artifact, 'POST /api/notes').evidence.filter((item) => item.kind === 'inert-effect');
    expect(inert).toHaveLength(1);
    expect(inert[0]!.symbol).toBe('demo.obs.AuditSink.record');
  });

  it('skips the sink without losing the response or the row', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    // `Note` is not Persistable, so `save()` with an id set is an UPDATE, as on
    // the server: the row the generated identifier lands on already exists.
    const existing = { id: GENERATED, organizationId: ORG, label: 'before' };
    const result = await run(artifact, 'POST /api/notes', { 'demo.notes.Note': [existing] }, {
      body: { label: 'first' }, context: { organizationId: ORG },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: GENERATED, organizationId: ORG, label: 'first' });
  });

  it('refuses to serve a handler whose answer reads the metadata', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/notes/LeakController.java': LEAKING_CONTROLLER }, CONFIG);
    const plan = endpoint(artifact, 'GET /api/leak/ip');
    expect(plan.offlineClass).toBe('UNSUPPORTED');
    expect(plan.reasons.join(' ')).toMatch(/request metadata/);
  });

  it('refuses an inert declaration on a method that answers something', async () => {
    const artifact = await compileJava(
      { ...SOURCES, 'demo/obs/TalkingSink.java': TALKING_SINK, 'demo/notes/TalkingController.java': TALKING_CONTROLLER },
      { ...CONFIG, inertEffects: ['AuditSink.record', 'TalkingSink.describe'] },
    );
    const plan = endpoint(artifact, 'GET /api/talking/describe');
    expect(plan.offlineClass).toBe('UNSUPPORTED');
    expect(plan.reasons.join(' ')).toMatch(/inert effect but returns Mono/);
  });

  it('fails closed when no declaration matches: the handler stays unsupported', async () => {
    const artifact = await compileJava(SOURCES, { ...CONFIG, inertEffects: ['AuditSink.recrod'] });
    const plan = endpoint(artifact, 'POST /api/notes');
    expect(plan.offlineClass).toBe('UNSUPPORTED');
  });

  it('leaves the read endpoint untouched by either mechanism', async () => {
    const artifact = await compileJava(SOURCES, CONFIG);
    const plan = endpoint(artifact, 'GET /api/notes');
    expect(plan.offlineClass).toBe('LOCAL_READ_SAFE');
    expect(plan.evidence.some((item) => item.kind === 'inert-effect')).toBe(false);
  });
});
