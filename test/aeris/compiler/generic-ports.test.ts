import { describe, expect, it } from 'vitest';
import { compileJava, endpoint } from './helpers.js';

/**
 * The template-method shape: an abstract service holds a generic port, and each
 * concrete service binds it to its own aggregate. Spring resolves such an
 * injection by the type argument, and so must the compiler — otherwise every
 * service sharing the base sees "several active implementations".
 */
const PORT = `
package demo.lib;
import reactor.core.publisher.Flux;
import java.util.UUID;
public interface CatalogPort<T> {
  Flux<T> ofOrganization(UUID organizationId);
}
`;

const COURSE = `
package demo.lib;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "course")
public class Course {
  @Id private UUID id;
  private UUID organizationId;
  private String title;
}
`;

const BOOK = `
package demo.lib;
import java.util.UUID;
import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Table(name = "book")
public class Book {
  @Id private UUID id;
  private UUID organizationId;
  private String isbn;
}
`;

const COURSE_PORT = `
package demo.lib;
public interface CoursePort extends CatalogPort<Course> {}
`;

const BOOK_PORT = `
package demo.lib;
public interface BookPort extends CatalogPort<Book> {}
`;

const COURSE_REPOSITORY = `
package demo.lib;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface CourseRepository extends ReactiveCrudRepository<Course, UUID> {
  Flux<Course> findByOrganizationId(UUID organizationId);
}
`;

const BOOK_REPOSITORY = `
package demo.lib;
import java.util.UUID;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import reactor.core.publisher.Flux;
public interface BookRepository extends ReactiveCrudRepository<Book, UUID> {
  Flux<Book> findByOrganizationId(UUID organizationId);
}
`;

const COURSE_ADAPTER = `
package demo.lib;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
@Component
public class CourseAdapter implements CoursePort {
  private final CourseRepository repository;
  public CourseAdapter(CourseRepository repository) { this.repository = repository; }
  @Override public Flux<Course> ofOrganization(UUID organizationId) {
    return repository.findByOrganizationId(organizationId);
  }
}
`;

const BOOK_ADAPTER = `
package demo.lib;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
@Component
public class BookAdapter implements BookPort {
  private final BookRepository repository;
  public BookAdapter(BookRepository repository) { this.repository = repository; }
  @Override public Flux<Book> ofOrganization(UUID organizationId) {
    return repository.findByOrganizationId(organizationId);
  }
}
`;

/** The field is typed on the base class's type variable, not on the aggregate. */
const ABSTRACT_SERVICE = `
package demo.lib;
import demo.kernel.RequestContextHolder;
import reactor.core.publisher.Flux;
public abstract class AbstractCatalogService<T> {
  protected final CatalogPort<T> port;
  protected AbstractCatalogService(CatalogPort<T> port) { this.port = port; }
  public Flux<T> mine() {
    return RequestContextHolder.getRequiredContext().flatMapMany(ctx -> port.ofOrganization(ctx.organizationId()));
  }
}
`;

const COURSE_SERVICE = `
package demo.lib;
import org.springframework.stereotype.Service;
@Service
public class CourseService extends AbstractCatalogService<Course> {
  public CourseService(CoursePort port) { super(port); }
}
`;

const BOOK_SERVICE = `
package demo.lib;
import org.springframework.stereotype.Service;
@Service
public class BookService extends AbstractCatalogService<Book> {
  public BookService(BookPort port) { super(port); }
}
`;

const CONTROLLER = `
package demo.lib;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
@RestController
@RequestMapping("/api/library")
public class LibraryController {
  private final CourseService courses;
  private final BookService books;
  public LibraryController(CourseService courses, BookService books) {
    this.courses = courses;
    this.books = books;
  }
  @GetMapping("/courses") public Flux<Course> courses() { return courses.mine(); }
  @GetMapping("/books") public Flux<Book> books() { return books.mine(); }
}
`;

const SOURCES = {
  'demo/lib/CatalogPort.java': PORT,
  'demo/lib/Course.java': COURSE,
  'demo/lib/Book.java': BOOK,
  'demo/lib/CoursePort.java': COURSE_PORT,
  'demo/lib/BookPort.java': BOOK_PORT,
  'demo/lib/CourseRepository.java': COURSE_REPOSITORY,
  'demo/lib/BookRepository.java': BOOK_REPOSITORY,
  'demo/lib/CourseAdapter.java': COURSE_ADAPTER,
  'demo/lib/BookAdapter.java': BOOK_ADAPTER,
  'demo/lib/AbstractCatalogService.java': ABSTRACT_SERVICE,
  'demo/lib/CourseService.java': COURSE_SERVICE,
  'demo/lib/BookService.java': BOOK_SERVICE,
  'demo/lib/LibraryController.java': CONTROLLER,
};

describe('a generic port shared by several services', () => {
  it('binds the port to each service own aggregate instead of giving up', async () => {
    const artifact = await compileJava(SOURCES);
    expect(endpoint(artifact, 'GET /api/library/courses').offlineClass).toBe('LOCAL_READ_SAFE');
    expect(endpoint(artifact, 'GET /api/library/books').offlineClass).toBe('LOCAL_READ_SAFE');
  });

  it('reads each aggregate own table, never the sibling one', async () => {
    const artifact = await compileJava(SOURCES);
    expect(endpoint(artifact, 'GET /api/library/courses').reads).toEqual(['demo.lib.Course']);
    expect(endpoint(artifact, 'GET /api/library/books').reads).toEqual(['demo.lib.Book']);
  });
});
