import { describe, expect, it } from 'vitest';
import { compileJava, endpoint } from './helpers.js';

/**
 * The commonest shape for reaching a child: load it by its own key, then let
 * its parent decide who may see it. The read itself proves nothing, so the
 * proof has to come from the guard that follows.
 */
const DOC = `
package demo.docs;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "doc")
public class Doc {
  @Id private UUID id;
  private UUID organizationId;
  private String title;
}
`;

const LINE = `
package demo.docs;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "doc_line")
public class Line {
  @Id private UUID id;
  private UUID docId;
  private String label;
}
`;

const DOC_REPOSITORY = `
package demo.docs;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface DocRepository extends ReactiveCrudRepository<Doc, UUID> {
  Flux<Doc> findByOrganizationId(UUID organizationId);
}
`;

const LINE_REPOSITORY = `
package demo.docs;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
public interface LineRepository extends ReactiveCrudRepository<Line, UUID> {}
`;

const MISSING = `
package demo.docs;
public class MissingException extends RuntimeException {
  public MissingException(String message) { super(message); }
}
`;

const ERRORS = `
package demo.docs;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@RestControllerAdvice
public class Errors {
  @ExceptionHandler(MissingException.class)
  public ResponseEntity<Map<String, Object>> missing(MissingException exception) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", exception.getMessage()));
  }
}
`;

/**
 * `tight` raises one and the same error whether the line is absent or its
 * document is out of scope. `loose` names which of the two happened, which both
 * tells a caller that a row it may not see exists, and makes the device answer
 * differently from the server.
 */
const controller = (error: { line: string; doc: string }) => `
package demo.docs;
import demo.kernel.RequestContextHolder;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@RestController
public class LineController {
  private final DocRepository docs;
  private final LineRepository lines;
  public LineController(DocRepository docs, LineRepository lines) {
    this.docs = docs;
    this.lines = lines;
  }

  @GetMapping("/api/lines/{lineId}")
  public Mono<Line> one(@PathVariable UUID lineId) {
    return lines.findById(lineId)
        .switchIfEmpty(Mono.error(new MissingException("${error.line}")))
        .flatMap(line -> RequestContextHolder.getRequiredContext()
            .flatMap(ctx -> docs.findById(line.getDocId())
                .filter(doc -> ctx.organizationId().equals(doc.getOrganizationId()))
                .switchIfEmpty(Mono.error(new MissingException("${error.doc}"))))
            .thenReturn(line));
  }

  @GetMapping("/api/docs")
  public Flux<Doc> mine() {
    return RequestContextHolder.getRequiredContext().flatMapMany(ctx -> docs.findByOrganizationId(ctx.organizationId()));
  }
}
`;

const sources = (error: { line: string; doc: string }) => ({
  'demo/docs/Doc.java': DOC,
  'demo/docs/Line.java': LINE,
  'demo/docs/DocRepository.java': DOC_REPOSITORY,
  'demo/docs/LineRepository.java': LINE_REPOSITORY,
  'demo/docs/MissingException.java': MISSING,
  'demo/docs/Errors.java': ERRORS,
  'demo/docs/LineController.java': controller(error),
});

const LINE_ENTITY = 'demo.docs.Line';
const DOC_ENTITY = 'demo.docs.Doc';

describe('a child proven by the parent checked right after it', () => {
  it('scopes the child when both guards raise the same error', async () => {
    const artifact = await compileJava(sources({ line: 'Not found', doc: 'Not found' }));
    const line = artifact.projections.find((candidate) => candidate.entity === LINE_ENTITY)!;
    expect(line.parent).toEqual({ field: 'docId', entity: DOC_ENTITY });
    expect(endpoint(artifact, 'GET /api/lines/{lineId}').offlineClass).toBe('LOCAL_READ_SAFE');
  });

  it('refuses when the two guards name which of them failed', async () => {
    const artifact = await compileJava(sources({ line: 'No such line', doc: 'No such document' }));
    expect(artifact.projections.map((candidate) => candidate.entity)).not.toContain(LINE_ENTITY);
    expect(endpoint(artifact, 'GET /api/lines/{lineId}').offlineClass).toBe('ONLINE_REQUIRED');
  });
});
