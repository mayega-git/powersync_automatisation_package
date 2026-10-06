import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

const ENTITY = `
package demo.points;
import java.time.LocalDateTime;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.domain.Persistable;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(schema = "sales", name = "points")
public class Point implements Persistable<UUID> {
  @Id private UUID id;
  @Transient @Builder.Default private boolean newEntity = true;
  @Override public boolean isNew() { return newEntity; }
  private UUID organizationId;
  private String name;
  private PointStatus status;
  private LocalDateTime createdAt;
}
`;

const STATUS = `
package demo.points;
public enum PointStatus { ACTIVE, CLOSED }
`;

const REPOSITORY = `
package demo.points;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface PointRepository extends ReactiveCrudRepository<Point, UUID> {
  Flux<Point> findByOrganizationIdOrderByNameAsc(UUID organizationId);
}
`;

const CALLBACK = `
package demo.points;
import org.reactivestreams.Publisher;
import org.springframework.data.r2dbc.mapping.event.AfterConvertCallback;
import org.springframework.data.relational.core.sql.SqlIdentifier;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
@Component
public class PointCallback implements AfterConvertCallback<Point> {
  @Override public Publisher<Point> onAfterConvert(Point entity, SqlIdentifier table) {
    entity.setNewEntity(false);
    return Mono.just(entity);
  }
}
`;

const REQUEST = `
package demo.points;
import jakarta.validation.constraints.*;
import lombok.Data;
@Data
public class CreatePoint {
  @NotBlank @Size(max = 20) private String name;
  private PointStatus status;
}
`;

const SERVICE = `
package demo.points;
import demo.kernel.RequestContextHolder;
import java.time.LocalDateTime;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@Service
public class PointService {
  private final PointRepository repository;
  public PointService(PointRepository repository) { this.repository = repository; }

  public Mono<Point> create(CreatePoint request) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> repository.save(Point.builder()
        .id(UUID.randomUUID())
        .organizationId(ctx.organizationId())
        .name(request.getName().trim())
        .status(request.getStatus() != null ? request.getStatus() : PointStatus.ACTIVE)
        .createdAt(LocalDateTime.now())
        .build()));
  }

  public Mono<Point> get(UUID id) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> repository.findById(id)
        .filter(point -> ctx.organizationId().equals(point.getOrganizationId()))
        .switchIfEmpty(Mono.error(new ResponseStatusException(HttpStatus.NOT_FOUND, "Point not found: " + id))));
  }

  public Flux<Point> mine() {
    return RequestContextHolder.getRequiredContext().flatMapMany(ctx -> repository.findByOrganizationIdOrderByNameAsc(ctx.organizationId()));
  }

  public Flux<Point> everything() {
    return repository.findAll();
  }

  public Mono<Point> close(UUID id) {
    return get(id).flatMap(point -> {
      if (point.getStatus() == PointStatus.CLOSED) {
        return Mono.error(new IllegalStateException("Already closed"));
      }
      point.setStatus(PointStatus.CLOSED);
      return repository.save(point);
    });
  }
}
`;

const CONTROLLER = `
package demo.points;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/points")
public class PointController {
  private final PointService service;
  public PointController(PointService service) { this.service = service; }
  @PostMapping @ResponseStatus(HttpStatus.CREATED)
  public Mono<Point> create(@Valid @RequestBody CreatePoint request) { return service.create(request); }
  @GetMapping("/{id}") public Mono<Point> get(@PathVariable UUID id) { return service.get(id); }
  @GetMapping public Flux<Point> mine() { return service.mine(); }
  @GetMapping("/all") public Flux<Point> all() { return service.everything(); }
  @PostMapping("/{id}/close") public Mono<Point> close(@PathVariable UUID id) { return service.close(id); }
}
`;

const ADVICE = `
package demo.points;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
@RestControllerAdvice
public class Errors {
  @ExceptionHandler(IllegalStateException.class)
  public ResponseEntity<Map<String, Object>> conflict(IllegalStateException exception) {
    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", "INVALID_STATE", "message", exception.getMessage()));
  }
}
`;

const SOURCES = {
  'demo/points/Point.java': ENTITY,
  'demo/points/PointStatus.java': STATUS,
  'demo/points/PointRepository.java': REPOSITORY,
  'demo/points/PointCallback.java': CALLBACK,
  'demo/points/CreatePoint.java': REQUEST,
  'demo/points/PointService.java': SERVICE,
  'demo/points/PointController.java': CONTROLLER,
  'demo/points/Errors.java': ADVICE,
};

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POINT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTITY_NAME = 'demo.points.Point';
const row = (id: string, organizationId: string, name: string, status = 'ACTIVE') => ({ id, organizationId, name, status, createdAt: '2026-01-01T08:00:00' });

describe('Spring Boot compiler', () => {
  it('classifies endpoints and infers the organization scope', async () => {
    const artifact = await compileJava(SOURCES);
    expect(endpoint(artifact, 'GET /api/points/{id}').offlineClass).toBe('LOCAL_READ_SAFE');
    expect(endpoint(artifact, 'GET /api/points').offlineClass).toBe('LOCAL_READ_SAFE');
    expect(endpoint(artifact, 'POST /api/points').offlineClass).toBe('REPLAYABLE');
    expect(endpoint(artifact, 'POST /api/points/{id}/close').offlineClass).toBe('SPECULATIVE');
    const all = endpoint(artifact, 'GET /api/points/all');
    expect(all.offlineClass).toBe('ONLINE_REQUIRED');
    expect(all.reasons[0]).toMatch(/not restricted/);
    const projection = artifact.projections.find((candidate) => candidate.entity === ENTITY_NAME)!;
    expect(projection).toMatchObject({ schema: 'sales', table: 'points', key: 'id' });
    expect(projection.scope).toEqual([{ field: 'organizationId', cmp: 'eq', value: { k: 'ctx', name: 'organizationId' } }]);
    expect(projection.columns.map((column) => `${column.name}:${column.column}`)).toEqual([
      'id:id', 'organizationId:organization_id', 'name:name', 'status:status', 'createdAt:created_at',
    ]);
  });

  it('reproduces ownership checks and Jackson output, including Persistable#isNew as "new"', async () => {
    const artifact = await compileJava(SOURCES);
    const rows = { [ENTITY_NAME]: [row(POINT, ORG, 'Main'), row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OTHER, 'Foreign')] };
    const mine = await run(artifact, 'GET /api/points/{id}', rows, { params: { id: POINT }, context: { organizationId: ORG } });
    expect(mine).toEqual({ status: 200, body: { id: POINT, organizationId: ORG, name: 'Main', status: 'ACTIVE', createdAt: '2026-01-01T08:00:00', new: false, newEntity: false } });
    const foreign = await run(artifact, 'GET /api/points/{id}', rows, { params: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, context: { organizationId: ORG } });
    expect(foreign.status).toBe(404);
    const list = await run(artifact, 'GET /api/points', { [ENTITY_NAME]: [row(POINT, ORG, 'Zeta'), row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ORG, 'Alpha')] }, { context: { organizationId: ORG } });
    expect((list.body as { name: string }[]).map((item) => item.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('creates with validation, captured ids and clock, and an id mapping for the receipt', async () => {
    const artifact = await compileJava(SOURCES);
    const created = await run(artifact, 'POST /api/points', {}, { body: { name: '  Kiosk ' }, context: { organizationId: ORG } });
    expect(created).toEqual({
      status: 201,
      body: { id: '00000000-0000-4000-8000-000000000001', organizationId: ORG, name: 'Kiosk', status: 'ACTIVE', createdAt: '2026-03-01T10:00:00', new: true, newEntity: true },
    });
    expect(endpoint(artifact, 'POST /api/points').sync).toMatchObject({ idempotency: 'backend-key', idMap: [{ slot: 0, responsePath: ['id'] }] });
    expect((await run(artifact, 'POST /api/points', {}, { body: { name: '   ' }, context: { organizationId: ORG } })).status).toBe(400);
    expect((await run(artifact, 'POST /api/points', {}, { body: { name: 'x'.repeat(21) }, context: { organizationId: ORG } })).status).toBe(400);
    expect((await run(artifact, 'POST /api/points', {}, { body: { name: 'ok', status: 'OPEN' }, context: { organizationId: ORG } })).status).toBe(400);
  });

  it('maps exceptions through @RestControllerAdvice with the handler body', async () => {
    const artifact = await compileJava(SOURCES);
    const rows = { [ENTITY_NAME]: [row(POINT, ORG, 'Main', 'CLOSED')] };
    const closed = await run(artifact, 'POST /api/points/{id}/close', rows, { params: { id: POINT }, context: { organizationId: ORG } });
    expect(closed).toEqual({ status: 409, body: { error: 'INVALID_STATE', message: 'Already closed' }, code: 'INVALID_STATE' });
    const open = await run(artifact, 'POST /api/points/{id}/close', { [ENTITY_NAME]: [row(POINT, ORG, 'Main')] }, { params: { id: POINT }, context: { organizationId: ORG } });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ status: 'CLOSED', new: false });
  });

  it('keeps creations online when the backend does not deduplicate replays', async () => {
    const artifact = await compileJava(SOURCES, { idempotency: undefined });
    const plan = endpoint(artifact, 'POST /api/points');
    expect(plan.offlineClass).toBe('ONLINE_REQUIRED');
    expect(plan.reasons[0]).toMatch(/idempotency/);
  });
});

describe('AERIS annotations', () => {
  it('can only restrict the computed class', async () => {
    const annotated = CONTROLLER
      .replace('@PostMapping @ResponseStatus(HttpStatus.CREATED)', '@io.aeris.annotations.AerisOffline(policy = io.aeris.annotations.AerisPolicy.SPECULATIVE) @PostMapping @ResponseStatus(HttpStatus.CREATED)')
      .replace('@GetMapping("/{id}")', '@io.aeris.annotations.AerisOnlineOnly("audit trail") @GetMapping("/{id}")')
      .replace('@GetMapping("/all")', '@io.aeris.annotations.AerisOffline(policy = io.aeris.annotations.AerisPolicy.LOCAL_READ_SAFE) @GetMapping("/all")');
    const artifact = await compileJava({ ...SOURCES, 'demo/points/PointController.java': annotated });
    expect(endpoint(artifact, 'POST /api/points').offlineClass, endpoint(artifact, 'POST /api/points').reasons.join('; ')).toBe('SPECULATIVE');
    expect(endpoint(artifact, 'GET /api/points/{id}')).toMatchObject({ offlineClass: 'ONLINE_REQUIRED', reasons: ['@AerisOnlineOnly: audit trail'] });
    // An annotation never grants what the analysis refused.
    expect(endpoint(artifact, 'GET /api/points/all').offlineClass).toBe('ONLINE_REQUIRED');
  });

  it('declares scope columns with @AerisScope', async () => {
    const scoped = ENTITY.replace('private UUID organizationId;', '@io.aeris.annotations.AerisScope("organizationId") private UUID organizationId;');
    // Without configuration, the scope is inferred from the claim equalities the backend's queries use.
    const inferred = await compileJava(SOURCES, { scopeClaims: {} });
    expect(inferred.projections.find((candidate) => candidate.entity === ENTITY_NAME)?.scope.map((filter) => filter.field)).toEqual(['organizationId']);
    const artifact = await compileJava({ ...SOURCES, 'demo/points/Point.java': scoped }, { scopeClaims: {} });
    const projection = artifact.projections.find((candidate) => candidate.entity === ENTITY_NAME);
    expect(projection?.scope.map((filter) => filter.field)).toEqual(['organizationId']);
  });
});
