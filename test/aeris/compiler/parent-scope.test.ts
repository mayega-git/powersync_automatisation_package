import { describe, expect, it } from 'vitest';
import { compileJava, endpoint, run } from './helpers.js';

/**
 * A child entity carrying no session claim of its own: the backend only ever
 * reads its rows for one parent row it has already checked. Nothing here is
 * specific to a framework convention or to a naming scheme — the proof comes
 * from the shape of the compiled program.
 */
const INVOICE = `
package demo.billing;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "invoice")
public class Invoice {
  @Id private UUID id;
  private UUID organizationId;
  private String reference;
}
`;

const LINE = `
package demo.billing;
import java.math.BigDecimal;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "invoice_line")
public class InvoiceLine {
  @Id private UUID id;
  private UUID invoiceId;
  private String label;
  private BigDecimal amount;
}
`;

const REPOSITORY = `
package demo.billing;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface InvoiceRepository extends ReactiveCrudRepository<Invoice, UUID> {
  Flux<Invoice> findByOrganizationId(UUID organizationId);
}
`;

const LINE_REPOSITORY = `
package demo.billing;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface InvoiceLineRepository extends ReactiveCrudRepository<InvoiceLine, UUID> {
  Flux<InvoiceLine> findByInvoiceIdOrderByLabelAsc(UUID invoiceId);
}
`;

const CONTROLLER = `
package demo.billing;
import demo.kernel.RequestContextHolder;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/api/invoices")
public class InvoiceController {
  private final InvoiceRepository invoices;
  private final InvoiceLineRepository lines;
  public InvoiceController(InvoiceRepository invoices, InvoiceLineRepository lines) {
    this.invoices = invoices;
    this.lines = lines;
  }

  @GetMapping public Flux<Invoice> mine() {
    return RequestContextHolder.getRequiredContext().flatMapMany(ctx -> invoices.findByOrganizationId(ctx.organizationId()));
  }

  @GetMapping("/{id}/lines") public Flux<InvoiceLine> linesOf(@PathVariable UUID id) {
    return RequestContextHolder.getRequiredContext()
        .flatMap(ctx -> invoices.findById(id)
            .filter(invoice -> ctx.organizationId().equals(invoice.getOrganizationId()))
            .switchIfEmpty(Mono.error(new ResponseStatusException(HttpStatus.NOT_FOUND, "No invoice"))))
        .flatMapMany(invoice -> lines.findByInvoiceIdOrderByLabelAsc(invoice.getId()));
  }
}
`;

/** The same listing, without ever checking the invoice belongs to the session. */
const LOOSE_CONTROLLER = `
package demo.billing;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
@RestController
@RequestMapping("/api/loose")
public class LooseController {
  private final InvoiceLineRepository lines;
  public LooseController(InvoiceLineRepository lines) { this.lines = lines; }
  @GetMapping("/lines") public Flux<InvoiceLine> all() { return lines.findAll(); }
}
`;

const SOURCES = {
  'demo/billing/Invoice.java': INVOICE,
  'demo/billing/InvoiceLine.java': LINE,
  'demo/billing/InvoiceRepository.java': REPOSITORY,
  'demo/billing/InvoiceLineRepository.java': LINE_REPOSITORY,
  'demo/billing/InvoiceController.java': CONTROLLER,
};

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE_ENTITY = 'demo.billing.Invoice';
const LINE_ENTITY = 'demo.billing.InvoiceLine';

describe('projections scoped through a parent row', () => {
  it('scopes a child entity through the parent its reads are restricted to', async () => {
    const artifact = await compileJava(SOURCES);
    const lines = artifact.projections.find((candidate) => candidate.entity === LINE_ENTITY)!;
    expect(lines.public).toBe(false);
    expect(lines.scope).toEqual([]);
    expect(lines.parent).toEqual({ field: 'invoiceId', entity: INVOICE_ENTITY });
    expect(endpoint(artifact, 'GET /api/invoices/{id}/lines').offlineClass).toBe('LOCAL_READ_SAFE');
  });

  it('carries the parent claims into the endpoint context', async () => {
    const artifact = await compileJava(SOURCES);
    expect(endpoint(artifact, 'GET /api/invoices/{id}/lines').auth.context).toContain('organizationId');
  });

  it('runs the compiled program against local rows', async () => {
    const artifact = await compileJava(SOURCES);
    const result = await run(artifact, 'GET /api/invoices/{id}/lines', {
      [INVOICE_ENTITY]: [{ id: INVOICE_ID, organizationId: ORG, reference: 'F-1' }],
      [LINE_ENTITY]: [
        { id: '33333333-3333-4333-8333-333333333333', invoiceId: INVOICE_ID, label: 'B', amount: 2 },
        { id: '44444444-4444-4444-8444-444444444444', invoiceId: INVOICE_ID, label: 'A', amount: 1 },
      ],
    }, { params: { id: INVOICE_ID }, context: { organizationId: ORG } });
    expect(result.status).toBe(200);
    expect((result.body as { label: string }[]).map((line) => line.label)).toEqual(['A', 'B']);
  });

  it('keeps the parent check: another organization gets a 404, not the lines', async () => {
    const artifact = await compileJava(SOURCES);
    const result = await run(artifact, 'GET /api/invoices/{id}/lines', {
      [INVOICE_ENTITY]: [{ id: INVOICE_ID, organizationId: ORG, reference: 'F-1' }],
      [LINE_ENTITY]: [{ id: '33333333-3333-4333-8333-333333333333', invoiceId: INVOICE_ID, label: 'B', amount: 2 }],
    }, { params: { id: INVOICE_ID }, context: { organizationId: OTHER } });
    expect(result.status).toBe(404);
  });

  it('refuses the scope when one read of the child is not restricted to a parent', async () => {
    const artifact = await compileJava({ ...SOURCES, 'demo/billing/LooseController.java': LOOSE_CONTROLLER });
    // No scope at all, so the entity is not projected and both endpoints stay online.
    expect(artifact.projections.map((candidate) => candidate.entity)).not.toContain(LINE_ENTITY);
    expect(endpoint(artifact, 'GET /api/loose/lines').offlineClass).toBe('ONLINE_REQUIRED');
    const scoped = endpoint(artifact, 'GET /api/invoices/{id}/lines');
    expect(scoped.offlineClass).toBe('ONLINE_REQUIRED');
    expect(scoped.reasons[0]).toMatch(/InvoiceLine/);
  });
});
