import { describe, expect, it } from 'vitest';
import { AERISCompileError, classifyEndpoint, compileAnalysis } from '../../src/aeris/compile.js';
import { SpringBootAdapter } from '../../src/aeris/SpringBootAdapter.js';

describe('SpringBootAdapter', () => {
  it('discovers constant Spring MVC routes and keeps them unsupported until semantic analysis exists', async () => {
    const source = `
      @RestController
      @RequestMapping("/api/orders")
      class OrderController {
        @GetMapping
        Object list() { return null; }

        @PostMapping("/{orderId}/submit")
        Object submit() { return null; }
      }
    `;
    const analysis = await new SpringBootAdapter().analyze({
      files: [{ path: 'OrderController.java', content: source }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints.map(({ operationId }) => operationId)).toEqual([
      'GET /api/orders',
      'POST /api/orders/{orderId}/submit',
    ]);
    expect(compileAnalysis(analysis).endpoints.map(({ policy }) => policy)).toEqual([
      'UNSUPPORTED',
      'UNSUPPORTED',
    ]);
  });

  it('skips dynamic route constants with a diagnostic', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: '@RestController @RequestMapping(BASE_PATH) class OrderController {}',
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints).toHaveLength(0);
    expect(analysis.diagnostics[0]).toMatch(/OrderController\.java: controller has ambiguous or dynamic class-level mappings/);
  });

  it('discovers each controller with its own class-level path in a shared source file', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'Controllers.java',
        content: `
          class Helper {}
          @RestController @RequestMapping("/orders") class OrderController {
            @GetMapping Object list() { return null; }
          }
          @RestController @RequestMapping("/customers") class CustomerController {
            @GetMapping Object list() { return null; }
          }
        `,
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints.map(({ operationId }) => operationId)).toEqual([
      'GET /orders',
      'GET /customers',
    ]);
  });

  it('parses RequestMapping path and HTTP method arrays from Java annotations', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'SearchController.java',
        content: '@RestController @RequestMapping(path={"/search","/lookup"}) class SearchController { @RequestMapping(path="/items", method={RequestMethod.GET, RequestMethod.POST}) Object search() { return null; } }',
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints.map(({ operationId }) => operationId)).toEqual([
      'GET /search/items',
      'GET /lookup/items',
      'POST /search/items',
      'POST /lookup/items',
    ]);
  });

  it('does not treat string values in RequestMapping method metadata as HTTP methods', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OddController.java',
        content: '@RestController class OddController { @RequestMapping(value="/x", method="GET") Object route() {} }',
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints).toHaveLength(0);
    expect(analysis.diagnostics[0]).toMatch(/no supported constant HTTP method/);
  });

  it('records direct handler calls and still refuses to infer business semantics', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: `
          @RestController class OrderController {
            @GetMapping("/orders")
            @PreAuthorize("hasAuthority('orders:read')")
            Object list() { return orderService.findAll(); }
          }
        `,
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ receiver, name }) => ({ receiver, name }))).toEqual([
      { receiver: 'orderService', name: 'findAll' },
    ]);
    expect(analysis.endpoints[0]?.requiresFreshAuthorization).toBe(true);
    expect(analysis.endpoints[0]?.evidence.map(({ kind }) => kind)).toEqual(['route', 'authorization']);
    expect(compileAnalysis(analysis).endpoints[0]?.policy).toBe('UNSUPPORTED');
  });

  it('inherits restrictive authorization annotations declared on a controller', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: '@RestController @PreAuthorize("hasAuthority(\'orders:read\')") class OrderController { @GetMapping("/orders") Object list() { return null; } }',
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.requiresFreshAuthorization).toBe(true);
    expect(analysis.endpoints[0]?.evidence.map(({ kind }) => kind)).toEqual(['route', 'authorization']);
  });

  it('resolves a controller-to-service-to-repository call chain across source files', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'OrderController.java',
          content: '@RestController class OrderController { private final OrderPort orderService; @GetMapping("/orders") Object list() { return orderService.list(); } }',
        },
        {
          path: 'OrderService.java',
          content: '@Transactional class OrderService implements OrderPort { private final OrderRepository orderRepository; @Transactional Object list() { return orderRepository.findAll(); } }',
        },
        {
          path: 'OrderPort.java',
          content: 'interface OrderPort { Object list(); }',
        },
        {
          path: 'OrderRepository.java',
          content: 'interface OrderRepository { Object findAll(); }',
        },
      ],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ name, resolution, targetClass }) => ({
      name,
      resolution,
      targetClass,
    }))).toEqual([
      { name: 'list', resolution: 'resolved', targetClass: 'OrderService' },
      { name: 'findAll', resolution: 'resolved', targetClass: 'OrderRepository' },
    ]);
    expect(compileAnalysis(analysis).endpoints[0]?.policy).toBe('UNSUPPORTED');
    expect(analysis.endpoints[0]?.evidence.filter(({ kind }) => kind === 'transaction')).toHaveLength(2);
  });

  it('resolves qualified calls from declared parameter types', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'OrderController.java',
          content: '@RestController class OrderController { @GetMapping("/orders") Object list(OrderService service) { return service.list(); } }',
        },
        {
          path: 'OrderService.java',
          content: 'class OrderService { Object list() { return null; } }',
        },
      ],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ name, resolution, targetClass }) => ({
      name,
      resolution,
      targetClass,
    }))).toEqual([
      { name: 'list', resolution: 'resolved', targetClass: 'OrderService' },
    ]);
  });

  it('marks interface dispatch ambiguous when multiple implementations match', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'Controller.java',
          content: '@RestController class Controller { private final Port port; @GetMapping("/x") Object get() { return port.run(); } }',
        },
        { path: 'Port.java', content: 'interface Port { Object run(); }' },
        { path: 'First.java', content: 'class First implements Port { public Object run() { return null; } }' },
        { path: 'Second.java', content: 'class Second implements Port { public Object run() { return null; } }' },
      ],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.[0]?.resolution).toBe('ambiguous');
    expect(analysis.endpoints[0]?.unresolved).toContain('One or more calls could not be resolved uniquely.');
  });

  it('extracts read and write entities from Spring Data repository contracts', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'OrderController.java',
          content: `
            @RestController class OrderController {
              private final OrderRepository orders;
              @GetMapping("/orders") Object read() { return orders.findById("id"); }
              @GetMapping("/orders/status") Object readByStatus() { return orders.findByStatus("OPEN"); }
              @PostMapping("/orders") Object write() { return orders.save(new OrderEntity()); }
              @DeleteMapping("/orders/status") Object deleteByStatus() { return orders.deleteByStatus("CLOSED"); }
            }
          `,
        },
        {
          path: 'OrderRepository.java',
          content: 'interface OrderRepository extends ReactiveCrudRepository<OrderEntity, UUID> { Flux<OrderEntity> findByStatus(String status); Mono<Void> deleteByStatus(String status); }',
        },
        { path: 'OrderEntity.java', content: 'class OrderEntity {}' },
      ],
      sourceRevision: 'test-revision',
    });

    const [read, readDerived, write, writeDerived] = analysis.endpoints;
    expect(read?.reads.map(({ entity }) => entity)).toEqual(['OrderEntity']);
    expect(read?.reads[0]?.evidence[0]?.kind).toBe('database-read');
    expect(write?.writes.map(({ entity }) => entity)).toEqual(['OrderEntity']);
    expect(write?.writes[0]?.evidence[0]?.kind).toBe('database-write');
    expect(readDerived?.reads.map(({ entity }) => entity)).toEqual(['OrderEntity']);
    expect(readDerived?.reads[0]?.evidence[0]?.kind).toBe('database-read');
    expect(writeDerived?.writes.map(({ entity }) => entity)).toEqual(['OrderEntity']);
    expect(writeDerived?.writes[0]?.evidence[0]?.kind).toBe('database-write');
    expect(read?.complete).toBe(false);
    expect(write?.complete).toBe(false);
  });

  it('recognizes known Reactor operators from declared Mono and Flux types', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: `
          import reactor.core.publisher.Mono;
          import reactor.core.publisher.Flux;
          @RestController class OrderController {
            private final Mono<String> orderName;
            private final Flux<String> orderNames;
            @GetMapping("/order") Object order() { return orderName.map(value -> value); }
            @GetMapping("/orders") Object orders() { return orderNames.collectList().flatMap(values -> Mono.just(values)); }
          }
        `,
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints.map(({ calls }) => calls?.map(({ name, resolution }) => ({ name, resolution })))).toEqual([
      [{ name: 'map', resolution: 'known-library' }],
      [
        { name: 'collectList', resolution: 'known-library' },
        { name: 'flatMap', resolution: 'known-library' },
        { name: 'just', resolution: 'known-library' },
      ],
    ]);
    expect(analysis.endpoints.map(({ unresolved }) => unresolved)).toEqual([
      ['Data access semantics, authorization, business effects and local execution plans are not analyzed yet.'],
      ['Data access semantics, authorization, business effects and local execution plans are not analyzed yet.'],
    ]);
    expect(compileAnalysis(analysis).endpoints.map(({ policy }) => policy)).toEqual([
      'UNSUPPORTED',
      'UNSUPPORTED',
    ]);
  });

  it('propagates source method return types before classifying chained Reactor operators', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'OrderController.java',
          content: `
            @RestController class OrderController {
              private final OrderService orderService;
              @GetMapping("/orders") Object orders() {
                return orderService.orders().map(order -> order);
              }
            }
          `,
        },
        {
          path: 'OrderService.java',
          content: `
            import reactor.core.publisher.Flux;
            class OrderService { Flux<String> orders() { return null; } }
          `,
        },
      ],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ name, resolution, targetClass }) => ({
      name,
      resolution,
      targetClass,
    }))).toEqual([
      { name: 'map', resolution: 'known-library', targetClass: undefined },
      { name: 'orders', resolution: 'resolved', targetClass: 'OrderService' },
    ]);
  });

  it('uses declared local variable types to recognize Reactor operators', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: `
          import reactor.core.publisher.Mono;
          @RestController class OrderController {
            @GetMapping("/order") Object order() {
              Mono<String> result = Mono.just("order");
              return result.map(value -> value);
            }
          }
        `,
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ name, resolution }) => ({ name, resolution }))).toEqual([
      { name: 'just', resolution: 'known-library' },
      { name: 'map', resolution: 'known-library' },
    ]);
  });

  it('does not trust a chain method just because its name matches a Reactor operator', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'OrderController.java',
        content: `
          @RestController class OrderController {
            private final ExternalPipeline pipeline;
            @GetMapping("/orders") Object orders() { return pipeline.map("orders"); }
          }
        `,
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.map(({ name, resolution }) => ({ name, resolution }))).toEqual([
      { name: 'map', resolution: 'unresolved' },
    ]);
    expect(analysis.endpoints[0]?.unresolved).toContain('One or more calls could not be resolved uniquely.');
  });

  it('marks same-arity overloads ambiguous instead of guessing a call target', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [
        {
          path: 'Controller.java',
          content: '@RestController class Controller { private final Service service; @GetMapping("/x") Object get() { return service.find(null); } }',
        },
        {
          path: 'Service.java',
          content: 'class Service { Object find(String value) { return value; } Object find(Integer value) { return value; } }',
        },
      ],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.calls?.[0]?.resolution).toBe('ambiguous');
    expect(compileAnalysis(analysis).endpoints[0]?.policy).toBe('UNSUPPORTED');
  });

  it('records a diagnostic when a mapped handler has no analyzable body', async () => {
    const analysis = await new SpringBootAdapter().analyze({
      files: [{
        path: 'AbstractController.java',
        content: '@RestController abstract class AbstractController { @GetMapping("/x") abstract Object route(); }',
      }],
      sourceRevision: 'test-revision',
    });

    expect(analysis.endpoints[0]?.unresolved).toContain('Handler body could not be resolved.');
  });

  it('does not classify an incomplete route as offline-capable', () => {
    const result = classifyEndpoint({
      operationId: 'GET /orders',
      method: 'GET',
      path: '/orders',
      complete: false,
      deterministic: false,
      requiresFreshAuthorization: false,
      hasStrictGlobalInvariant: false,
      hasIrreversibleExternalEffect: false,
      replaySemantics: 'unknown',
      reads: [],
      writes: [],
      evidence: [],
      unresolved: [],
    });

    expect(result.policy).toBe('UNSUPPORTED');
  });

  it('requires a terminal local behavior plan before classifying a read offline-safe', () => {
    const evidence = {
      file: 'OrderController.java',
      symbol: 'list',
      kind: 'database-read' as const,
      startLine: 1,
      endLine: 1,
      excerptHash: 'a'.repeat(64),
    };
    const endpoint = {
      operationId: 'GET /orders',
      method: 'GET' as const,
      path: '/orders',
      complete: true,
      deterministic: true,
      requiresFreshAuthorization: false,
      hasStrictGlobalInvariant: false,
      hasIrreversibleExternalEffect: false,
      replaySemantics: 'unknown' as const,
      reads: [{ entity: 'Order', evidence: [evidence] }],
      writes: [],
      evidence: [evidence],
      unresolved: [],
    };

    expect(classifyEndpoint(endpoint)).toMatchObject({
      policy: 'UNSUPPORTED',
      reasons: ['No executable local behavior plan was emitted for this endpoint.'],
    });
    expect(classifyEndpoint({
      ...endpoint,
      behaviorPlan: {
        engine: 'aeris-behavior-v1',
        instructions: [
          { op: 'QUERY', entity: 'Order', output: 'orders', filters: [] },
          { op: 'RETURN', value: { source: 'variable', name: 'orders' } },
        ],
      },
    }).policy).toBe('LOCAL_READ_SAFE');
  });

  it('rejects unbounded deletes and replayable writes without an outbox instruction', () => {
    const endpoint = {
      operationId: 'DELETE /orders',
      method: 'DELETE' as const,
      path: '/orders',
      complete: true,
      deterministic: true,
      requiresFreshAuthorization: false,
      hasStrictGlobalInvariant: false,
      hasIrreversibleExternalEffect: false,
      replaySemantics: 'idempotent' as const,
      reads: [],
      writes: [{
        entity: 'Order',
        evidence: [{
          file: 'OrderService.java', symbol: 'delete', kind: 'database-write' as const,
          startLine: 1, endLine: 1, excerptHash: 'c'.repeat(64),
        }],
      }],
      evidence: [{
        file: 'OrderController.java', symbol: 'delete', kind: 'route' as const,
        startLine: 1, endLine: 1, excerptHash: 'b'.repeat(64),
      }],
      unresolved: [],
      behaviorPlan: {
        engine: 'aeris-behavior-v1' as const,
        instructions: [
          {
            op: 'DELETE' as const,
            entity: 'Order',
            filters: [{
              field: 'id', operator: 'eq' as const, value: { source: 'path' as const, name: 'id' },
            }],
          },
          { op: 'RETURN' as const, value: { source: 'constant' as const, value: null } },
        ],
      },
    };
    const analysis = {
      adapter: { id: 'test', version: '1', language: 'java', framework: 'spring' },
      sourceRevision: 'revision',
      diagnostics: [],
    };
    expect(() => compileAnalysis({ ...analysis, endpoints: [endpoint] }))
      .toThrow(/no QUEUE_INTENT instruction/);
    expect(() => compileAnalysis({
      ...analysis,
      endpoints: [{
        ...endpoint,
        writes: [],
        behaviorPlan: {
          ...endpoint.behaviorPlan,
          instructions: [
            { op: 'DELETE' as const, entity: 'Order', filters: [] },
            { op: 'RETURN' as const, value: { source: 'constant' as const, value: null } },
          ],
        },
      }],
    })).toThrow(/malformed or non-terminating behavior plan/);
  });

  it('rejects artifact facts whose operation id disagrees with their route', () => {
    expect(() => compileAnalysis({
      adapter: { id: 'test', version: '1', language: 'java', framework: 'spring' },
      sourceRevision: 'revision',
      diagnostics: [],
      endpoints: [{
        operationId: 'GET /different',
        method: 'GET',
        path: '/orders',
        complete: false,
        deterministic: false,
        requiresFreshAuthorization: false,
        hasStrictGlobalInvariant: false,
        hasIrreversibleExternalEffect: false,
        replaySemantics: 'unknown',
        reads: [],
        writes: [],
        evidence: [],
        unresolved: [],
      }],
    })).toThrow(AERISCompileError);
  });

  it('rejects malformed source evidence rather than emitting an untraceable artifact', () => {
    expect(() => compileAnalysis({
      adapter: { id: 'test', version: '1', language: 'java', framework: 'spring' },
      sourceRevision: 'revision',
      diagnostics: [],
      endpoints: [{
        operationId: 'GET /orders',
        method: 'GET',
        path: '/orders',
        complete: false,
        deterministic: false,
        requiresFreshAuthorization: false,
        hasStrictGlobalInvariant: false,
        hasIrreversibleExternalEffect: false,
        replaySemantics: 'unknown',
        reads: [],
        writes: [],
        evidence: [{
          file: 'OrderController.java',
          symbol: 'list',
          kind: 'route',
          startLine: 1,
          endLine: 2,
          excerptHash: 'not-a-sha256',
        }],
        unresolved: [],
      }],
    })).toThrow(/invalid source evidence/);
  });
});
