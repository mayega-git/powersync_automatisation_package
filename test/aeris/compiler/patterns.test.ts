import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

const PERSISTABLE = `
package demo.common;
import java.time.Instant;
import java.util.UUID;
import org.springframework.data.domain.Persistable;
public interface PersistableEntity extends Persistable<UUID> {
  UUID id();
  Instant createdAt();
  Instant updatedAt();
  @Override default UUID getId() { return id(); }
  @Override default boolean isNew() {
    Instant createdAt = createdAt();
    return createdAt == null || createdAt.equals(updatedAt());
  }
}
`;

const LINE_ENTITY = `
package demo.orders;
import demo.common.PersistableEntity;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Table(schema = "orders", name = "order_line")
public record LineEntity(@Id UUID id, UUID tenantId, UUID orderId, String label, BigDecimal amount, String kind,
    Instant createdAt, Instant updatedAt) implements PersistableEntity {}
`;

const KIND = `
package demo.orders;
public enum LineKind {
  GOODS("G", 1), SERVICE("S", 2);
  private final String code;
  private final int weight;
  LineKind(String code, int weight) { this.code = code; this.weight = weight; }
  public String code() { return code; }
  public int weight() { return weight; }
}
`;

const LINE = `
package demo.orders;
import java.math.BigDecimal;
import java.util.UUID;
public record Line(UUID id, UUID orderId, String label, BigDecimal amount, LineKind kind) {
  public Line {
    if (label == null || label.isBlank()) throw new IllegalArgumentException("label is required");
  }
}
`;

const PORT = `
package demo.orders;
import java.util.UUID;
import reactor.core.publisher.Flux;
public interface LinePort {
  Flux<Line> forOrder(UUID tenantId, UUID orderId);
}
`;

const ADAPTER = `
package demo.orders;
import static org.springframework.data.relational.core.query.Criteria.where;
import java.util.UUID;
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate;
import org.springframework.data.relational.core.query.Query;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
@Component
public class LineAdapter implements LinePort {
  private final R2dbcEntityTemplate template;
  public LineAdapter(R2dbcEntityTemplate template) { this.template = template; }
  @Override public Flux<Line> forOrder(UUID tenantId, UUID orderId) {
    return template.select(Query.query(where("tenant_id").is(tenantId).and("order_id").is(orderId)), LineEntity.class)
        .map(LineAdapter::toDomain);
  }
  private static Line toDomain(LineEntity e) {
    LineKind kind;
    try {
      kind = LineKind.valueOf(e.kind());
    } catch (IllegalArgumentException unknown) {
      kind = LineKind.GOODS;
    }
    return new Line(e.id(), e.orderId(), e.label(), e.amount(), kind);
  }
}
`;

const SUMMARY = `
package demo.orders;
import java.math.BigDecimal;
import java.util.List;
public record OrderSummary(int count, BigDecimal total, String heaviest, List<String> labels) {}
`;

const SERVICE = `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
@Service
public class OrderService {
  private final LinePort lines;
  public OrderService(LinePort lines) { this.lines = lines; }
  public Mono<OrderSummary> summary(UUID orderId) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId)
        .sort(Comparator.comparing(Line::label))
        .collectList()
        .map(this::summarize));
  }
  private OrderSummary summarize(List<Line> items) {
    BigDecimal total = BigDecimal.ZERO;
    int heaviest = 0;
    String heaviestLabel = null;
    List<String> labels = new ArrayList<>();
    for (Line line : items) {
      total = total.add(line.amount());
      labels.add(line.label() + "/" + line.kind().code());
      if (line.kind().weight() > heaviest) {
        heaviest = line.kind().weight();
        heaviestLabel = line.label();
      }
    }
    String band = switch (items.size()) {
      case 0 -> "empty";
      case 1, 2 -> "small";
      default -> "large";
    };
    return new OrderSummary(items.size(), total.setScale(2, RoundingMode.HALF_UP), heaviestLabel == null ? band : heaviestLabel, labels);
  }
}
`;

const CONTROLLER = `
package demo.orders;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService service;
  private final WebClient payments;
  private final java.util.Map<UUID, String> cache = new java.util.HashMap<>();
  public OrderController(OrderService service, WebClient payments) { this.service = service; this.payments = payments; }
  @GetMapping("/{orderId}/summary") public Mono<OrderSummary> summary(@PathVariable UUID orderId) { return service.summary(orderId); }
  @PostMapping("/{orderId}/pay") public Mono<String> pay(@PathVariable UUID orderId) {
    return payments.post().uri("/pay/" + orderId).retrieve().bodyToMono(String.class);
  }
  @GetMapping("/{orderId}/cached") public Mono<String> cached(@PathVariable UUID orderId) { return Mono.justOrEmpty(cache.get(orderId)); }
}
`;

const SOURCES = {
  'demo/common/PersistableEntity.java': PERSISTABLE,
  'demo/orders/LineEntity.java': LINE_ENTITY,
  'demo/orders/LineKind.java': KIND,
  'demo/orders/Line.java': LINE,
  'demo/orders/LinePort.java': PORT,
  'demo/orders/LineAdapter.java': ADAPTER,
  'demo/orders/OrderSummary.java': SUMMARY,
  'demo/orders/OrderService.java': SERVICE,
  'demo/orders/OrderController.java': CONTROLLER,
};

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '33333333-3333-4333-8333-333333333333';
const line = (id: number, label: string, amount: number, kind: string, tenantId = TENANT) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`, tenantId, orderId: ORDER, label, amount, kind, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

describe('compiler on hexagonal code', () => {
  it('compiles ports, template criteria, records, loops, sort, switch, try/catch and enum fields', async () => {
    const artifact = await compileJava(SOURCES);
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/summary');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const rows = {
      'demo.orders.LineEntity': [
        line(1, 'b-bolt', 1.105, 'SERVICE'),
        line(2, 'a-axle', 10.2, 'GOODS'),
        line(3, 'c-cable', 0.1, 'LEGACY'),
        line(4, 'z-foreign', 999, 'GOODS', '22222222-2222-4222-8222-222222222222'),
      ],
    };
    const result = await run(artifact, 'GET /api/orders/{orderId}/summary', rows, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(result).toEqual({
      status: 200,
      body: { count: 3, total: 11.41, heaviest: 'b-bolt', labels: ['a-axle/G', 'b-bolt/S', 'c-cable/G'] },
    });
    const empty = await run(artifact, 'GET /api/orders/{orderId}/summary', {}, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(empty.body).toEqual({ count: 0, total: 0, heaviest: 'empty', labels: [] });
  });

  it('propagates domain invariants of mapped rows as errors', async () => {
    const artifact = await compileJava(SOURCES);
    const broken = { 'demo.orders.LineEntity': [line(1, ' ', 1, 'GOODS')] };
    const result = await run(artifact, 'GET /api/orders/{orderId}/summary', broken, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(result.status).toBe(500);
  });

  it('keeps external effects online and refuses in-memory state', async () => {
    const artifact = await compileJava(SOURCES);
    const pay = endpoint(artifact, 'POST /api/orders/{orderId}/pay');
    expect(pay.offlineClass).toBe('ONLINE_REQUIRED');
    expect(pay.reasons[0]).toMatch(/WebClient/);
    const cached = endpoint(artifact, 'GET /api/orders/{orderId}/cached');
    expect(cached.offlineClass).toBe('UNSUPPORTED');
    expect(cached.reasons[0]).toMatch(/holds state/);
  });

  it('compiles conditional returns: try/return guarded by if, then the first loop element that returns', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/orders/KindController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class KindController {
  private final LinePort lines;
  public KindController(LinePort lines) { this.lines = lines; }
  @GetMapping("/{orderId}/kind") public Mono<String> kind(@PathVariable UUID orderId, @RequestParam(required = false) String preferred) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId)
        .map(Line::label).collectList().map(labels -> resolve(preferred, labels)));
  }
  private static String resolve(String preferred, List<String> labels) {
    if (preferred != null && !preferred.isBlank()) {
      try {
        return LineKind.valueOf(preferred.trim().toUpperCase()).code();
      } catch (IllegalArgumentException ignored) {
        // fall through to the labels
      }
    }
    for (String label : labels) {
      try {
        return LineKind.valueOf(label.toUpperCase()).code();
      } catch (RuntimeException ignored) {
        // try the next label
      }
    }
    return "none";
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/kind');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const rows = { 'demo.orders.LineEntity': [line(1, 'bolt', 1, 'GOODS'), line(2, 'service', 1, 'GOODS'), line(3, 'goods', 1, 'GOODS')] };
    const ask = (preferred?: string) => run(artifact, 'GET /api/orders/{orderId}/kind', rows, { params: { orderId: ORDER }, query: preferred === undefined ? {} : { preferred }, context: { tenantId: TENANT } });
    expect((await ask()).body).toBe('S');
    expect((await ask(' goods ')).body).toBe('G');
    expect((await ask('legacy')).body).toBe('S');
    const none = await run(artifact, 'GET /api/orders/{orderId}/kind', { 'demo.orders.LineEntity': [line(1, 'bolt', 1, 'GOODS')] }, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(none.body).toBe('none');
  });

  it('compiles Mono.onErrorReturn into a read-only TRY that also catches failures of the mapped value', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/orders/HeadlineController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class HeadlineController {
  private final LinePort lines;
  public HeadlineController(LinePort lines) { this.lines = lines; }
  @GetMapping("/{orderId}/headline") public Mono<String> headline(@PathVariable UUID orderId) {
    return RequestContextHolder.getRequiredContext()
        .flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId).collectList())
        .map(items -> items.getFirst().label().toUpperCase())
        .onErrorReturn("none");
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/headline');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    expect(JSON.stringify(plan.program)).toContain('"op":"TRY"');
    const ask = (rows: Record<string, unknown>[]) => run(artifact, 'GET /api/orders/{orderId}/headline', { 'demo.orders.LineEntity': rows as never }, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(await ask([line(1, 'bolt', 1, 'GOODS')])).toEqual({ status: 200, body: 'BOLT' });
    expect(await ask([])).toEqual({ status: 200, body: 'none' });
    expect(await ask([line(1, ' ', 1, 'GOODS')])).toEqual({ status: 200, body: 'none' });
  });

  it('compiles per-element lookups (Flux.flatMap to a Mono query) into an EACH, dropping empty results', async () => {
    const artifact = await compileJava({ ...SOURCES,
      'demo/orders/ProductEntity.java': `
package demo.orders;
import demo.common.PersistableEntity;
import java.time.Instant;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Table(schema = "orders", name = "product")
public record ProductEntity(@Id UUID id, UUID tenantId, String name, Instant createdAt, Instant updatedAt) implements PersistableEntity {}
`,
      'demo/orders/ProductRepository.java': `
package demo.orders;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Mono;
public interface ProductRepository extends ReactiveCrudRepository<ProductEntity, UUID> {
  Mono<ProductEntity> findByIdAndTenantId(UUID id, UUID tenantId);
}
`,
      'demo/orders/ProductController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class ProductController {
  private final LinePort lines;
  private final ProductRepository products;
  public ProductController(LinePort lines, ProductRepository products) { this.lines = lines; this.products = products; }
  @GetMapping("/{orderId}/products") public Mono<List<String>> names(@PathVariable UUID orderId) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId)
        .flatMap(line -> products.findByIdAndTenantId(line.id(), ctx.tenantId()).map(product -> product.name().toUpperCase()))
        .collectList());
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/products');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    expect(JSON.stringify(plan.program)).toContain('"op":"EACH"');
    const product = (id: number, name: string, tenantId = TENANT) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, tenantId, name, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    const rows = {
      'demo.orders.LineEntity': [line(1, 'a', 1, 'GOODS'), line(2, 'b', 1, 'GOODS'), line(3, 'c', 1, 'GOODS')],
      'demo.orders.ProductEntity': [product(1, 'bolt'), product(3, 'cable'), product(2, 'foreign', '22222222-2222-4222-8222-222222222222')],
    };
    const result = await run(artifact, 'GET /api/orders/{orderId}/products', rows, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(result).toEqual({ status: 200, body: ['BOLT', 'CABLE'] });
  });

  it('compiles stream reduce with an identity into a fold', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/orders/TotalController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class TotalController {
  private final LinePort lines;
  public TotalController(LinePort lines) { this.lines = lines; }
  @GetMapping("/{orderId}/total") public Mono<BigDecimal> total(@PathVariable UUID orderId) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId).collectList())
        .map(items -> items.stream().map(Line::amount).reduce(BigDecimal.ZERO, BigDecimal::add));
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/total');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const result = await run(artifact, 'GET /api/orders/{orderId}/total', { 'demo.orders.LineEntity': [line(1, 'a', 1.1, 'GOODS'), line(2, 'b', 2.25, 'GOODS')] }, { params: { orderId: ORDER }, context: { tenantId: TENANT } });
    expect(result).toEqual({ status: 200, body: 3.35 });
  });

  it('answers runtime-detected failures (null dereference, binding) through the backend exception handlers', async () => {
    const artifact = await compileJava({ ...SOURCES,
      'demo/orders/Failures.java': `
package demo.orders;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;
@RestControllerAdvice
public class Failures {
  @ExceptionHandler(ResponseStatusException.class)
  public ResponseEntity<Map<String, Object>> status(ResponseStatusException exception) {
    return ResponseEntity.status(exception.getStatusCode()).body(Map.of("error", "BAD_INPUT"));
  }
  @ExceptionHandler(Throwable.class)
  public ResponseEntity<Map<String, Object>> any(Throwable exception) {
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "UNEXPECTED"));
  }
}
`,
      'demo/orders/EchoController.java': `
package demo.orders;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
public class EchoController {
  @GetMapping("/api/echo") public Mono<String> echo(@RequestParam(required = false) String text, @RequestParam int times) {
    return Mono.just(text.toUpperCase() + times);
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/echo');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const ask = (query: Record<string, string>) => run(artifact, 'GET /api/echo', {}, { query, context: { tenantId: TENANT } });
    expect((await ask({ text: 'a', times: '2' })).body).toBe('A2');
    expect(await ask({ times: '2' })).toMatchObject({ status: 500, body: { error: 'UNEXPECTED' } });
    expect(await ask({ text: 'a' })).toMatchObject({ status: 400, body: { error: 'BAD_INPUT' } });
    expect(await ask({ text: 'a', times: 'x' })).toMatchObject({ status: 400, body: { error: 'BAD_INPUT' } });
  });

  it('refuses to invent the response of a failure two unordered advices handle', async () => {
    const advice = (name: string, label: string) => `
package demo.orders;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
@RestControllerAdvice
public class ${name} {
  @ExceptionHandler(NullPointerException.class)
  public ResponseEntity<Map<String, Object>> npe(NullPointerException exception) {
    return ResponseEntity.status(500).body(Map.of("by", "${label}"));
  }
}
`;
    const artifact = await compileJava({ ...SOURCES,
      'demo/orders/FirstAdvice.java': advice('FirstAdvice', 'first'),
      'demo/orders/SecondAdvice.java': advice('SecondAdvice', 'second'),
      'demo/orders/EchoController.java': `
package demo.orders;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
public class EchoController {
  @GetMapping("/api/echo") public Mono<String> echo(@RequestParam(required = false) String text) {
    return Mono.just(text.toUpperCase());
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/echo');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    expect(plan.opaqueFailures).toContain('NULL_DEREFERENCE');
    expect((await run(artifact, 'GET /api/echo', {}, { query: { text: 'a' }, context: { tenantId: TENANT } })).body).toBe('A');
    await expect(run(artifact, 'GET /api/echo', {}, { query: {}, context: { tenantId: TENANT } })).rejects.toThrow(/cannot be reproduced/);
  });

  it('compiles array length, indexed access in counted loops, and List.get bounds', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/orders/PayloadController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class PayloadController {
  private final LinePort lines;
  public PayloadController(LinePort lines) { this.lines = lines; }
  @GetMapping("/{orderId}/payload") public Mono<Map<String, Object>> payload(@PathVariable UUID orderId, @RequestParam String text) {
    return Mono.just(entries("order", orderId, "text", text));
  }
  @GetMapping("/{orderId}/second") public Mono<String> second(@PathVariable UUID orderId) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId).collectList())
        .map(items -> items.get(1).label());
  }
  private Map<String, Object> entries(Object... values) {
    Map<String, Object> payload = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) payload.put(values[i].toString(), values[i + 1]);
    return payload;
  }
}
` });
    const payload = endpoint(artifact, 'GET /api/orders/{orderId}/payload');
    expect(payload.offlineClass, payload.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    expect((await run(artifact, 'GET /api/orders/{orderId}/payload', {}, { params: { orderId: ORDER }, query: { text: 'hi' }, context: { tenantId: TENANT } })).body)
      .toEqual({ order: ORDER, text: 'hi' });
    const second = endpoint(artifact, 'GET /api/orders/{orderId}/second');
    expect(second.offlineClass, second.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const rows = { 'demo.orders.LineEntity': [line(1, 'a', 1, 'GOODS'), line(2, 'b', 1, 'GOODS')] };
    expect((await run(artifact, 'GET /api/orders/{orderId}/second', rows, { params: { orderId: ORDER }, context: { tenantId: TENANT } })).body).toBe('b');
    expect(await run(artifact, 'GET /api/orders/{orderId}/second', { 'demo.orders.LineEntity': [line(1, 'a', 1, 'GOODS')] }, { params: { orderId: ORDER }, context: { tenantId: TENANT } }))
      .toMatchObject({ status: 500, code: 'LIST_INDEX' });
  });
});

const PRODUCT_SOURCES = {
  'demo/orders/ProductEntity.java': `
package demo.orders;
import demo.common.PersistableEntity;
import java.time.Instant;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Table(schema = "orders", name = "product")
public record ProductEntity(@Id UUID id, UUID tenantId, String name, Instant createdAt, Instant updatedAt) implements PersistableEntity {}
`,
  'demo/orders/ProductRepository.java': `
package demo.orders;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Mono;
public interface ProductRepository extends ReactiveCrudRepository<ProductEntity, UUID> {
  Mono<ProductEntity> findByIdAndTenantId(UUID id, UUID tenantId);
  Mono<Boolean> existsByIdAndTenantId(UUID id, UUID tenantId);
}
`,
};

describe('per-element reads', () => {
  it('compiles Flux.filterWhen and Flux.map whose function reads data into EACH', async () => {
    const artifact = await compileJava({ ...SOURCES, ...PRODUCT_SOURCES, 'demo/orders/CatalogController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/orders")
public class CatalogController {
  private final LinePort lines;
  private final ProductRepository products;
  public CatalogController(LinePort lines, ProductRepository products) { this.lines = lines; this.products = products; }
  @GetMapping("/{orderId}/known") public Mono<List<String>> known(@PathVariable UUID orderId) {
    return RequestContextHolder.getRequiredContext().flatMap(ctx -> lines.forOrder(ctx.tenantId(), orderId)
        .filterWhen(line -> products.existsByIdAndTenantId(line.id(), ctx.tenantId()))
        .map(Line::label)
        .collectList());
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/orders/{orderId}/known');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    expect(JSON.stringify(plan.program)).toContain('"op":"EACH"');
    const product = (id: number) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, tenantId: TENANT, name: `p${id}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    const rows = {
      'demo.orders.LineEntity': [line(1, 'a', 1, 'GOODS'), line(2, 'b', 1, 'GOODS'), line(3, 'c', 1, 'GOODS')],
      'demo.orders.ProductEntity': [product(1), product(3)],
    };
    expect((await run(artifact, 'GET /api/orders/{orderId}/known', rows, { params: { orderId: ORDER }, context: { tenantId: TENANT } })).body).toEqual(['a', 'c']);
  });
});

describe('library semantics', () => {
  it('compiles String.format with constant patterns, YearMonth and switch (this) in enums', async () => {
    const artifact = await compileJava({ ...SOURCES,
      'demo/orders/Period.java': `
package demo.orders;
import java.time.YearMonth;
public record Period(int year, int month) {
  public static Period parse(String value) {
    YearMonth ym = YearMonth.parse(value);
    return new Period(ym.getYear(), ym.getMonthValue());
  }
  public String format() { return String.format("%04d-%02d", year, month); }
}
`,
      'demo/orders/Band.java': `
package demo.orders;
public enum Band {
  LOW, HIGH;
  public String label() {
    return switch (this) {
      case LOW -> "low";
      case HIGH -> "high";
    };
  }
}
`,
      'demo/orders/FormatController.java': `
package demo.orders;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
public class FormatController {
  @GetMapping("/api/period") public Mono<String> period(@RequestParam String value, @RequestParam Band band, @RequestParam int count) {
    return Mono.just(Period.parse(value).format() + "/" + band.label() + String.format("[%5d|%s|%%]", count, value));
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/period');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const ask = (value: string, count = '7') => run(artifact, 'GET /api/period', {}, { query: { value, band: 'HIGH', count }, context: { tenantId: TENANT } });
    expect((await ask('2026-03')).body).toBe('2026-03/high[    7|2026-03|%]');
    expect((await ask('0007-11', '-123456')).body).toBe('0007-11/high[-123456|0007-11|%]');
    expect((await ask('2026-13')).status).toBe(500);
    expect((await ask('26-01')).status).toBe(500);
  });
});

describe('response choices', () => {
  it('compiles map(ok).defaultIfEmpty(notFound).onErrorResume(500) with exact statuses', async () => {
    const artifact = await compileJava({ ...SOURCES, ...PRODUCT_SOURCES, 'demo/orders/ProductLookupController.java': `
package demo.orders;
import demo.kernel.RequestContextHolder;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
public class ProductLookupController {
  private final ProductRepository products;
  public ProductLookupController(ProductRepository products) { this.products = products; }
  @GetMapping("/api/products/{id}") public Mono<ResponseEntity<String>> get(@PathVariable UUID id) {
    return RequestContextHolder.getRequiredContext()
        .flatMap(ctx -> products.findByIdAndTenantId(id, ctx.tenantId()))
        .map(product -> product.name().toUpperCase())
        .map(ResponseEntity::ok)
        .defaultIfEmpty(ResponseEntity.notFound().build())
        .onErrorResume(e -> Mono.just(ResponseEntity.status(500).build()));
  }
}
` });
    const plan = endpoint(artifact, 'GET /api/products/{id}');
    expect(plan.offlineClass, plan.reasons.join('; ')).toBe('LOCAL_READ_SAFE');
    const product = (id: number, name: string | null) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, tenantId: TENANT, name, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    const rows = { 'demo.orders.ProductEntity': [product(1, 'bolt'), product(2, null)] };
    const ask = (id: number) => run(artifact, 'GET /api/products/{id}', rows, { params: { id: `00000000-0000-4000-8000-00000000000${id}` }, context: { tenantId: TENANT } });
    expect(await ask(1)).toEqual({ status: 200, body: 'BOLT' });
    expect(await ask(3)).toEqual({ status: 404, body: null });
    expect(await ask(2)).toEqual({ status: 500, body: null });
  });
});
