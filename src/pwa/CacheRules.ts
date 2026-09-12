import {
  EntityRoutes,
  type DeclaredPath,
  type EntitiesDeclaration,
} from '../core/EntityRoutes.js';
import { REPLAY_HEADER } from '../core/OfflineSyncConnector.js';

export { REPLAY_HEADER };

/** The prefix that must never be pulled off the network, absent a better default. */
export const DEFAULT_ONLINE_ONLY_PREFIXES = ['/api/auth'] as const;

export interface CacheRulesOptions {
  /** The declaration, the same one passed to `OfflineSync.create`. */
  entities: EntitiesDeclaration;
  /** Paths that stay online no matter what. Defaults to `/api/auth`. */
  onlineOnly?: readonly string[];
}

/**
 * Cache rules, computed once at Service Worker startup. `create` never
 * throws: a bad declaration is already reported at module startup in the
 * page. Throwing here would kill the Service Worker at load time.
 */
export class CacheRules {
  private constructor(
    private readonly routes: EntityRoutes | undefined,
    private readonly onlineOnly: readonly string[],
  ) {}

  static create(options: CacheRulesOptions): CacheRules {
    let routes: EntityRoutes | undefined;
    try {
      routes = EntityRoutes.build(options.entities);
    } catch {
      routes = undefined;
    }
    return new CacheRules(
      routes,
      options.onlineOnly ?? [...DEFAULT_ONLINE_ONLY_PREFIXES],
    );
  }

  /** True means: the Service Worker doesn't answer itself, it asks the page. */
  belongsToModule(method: string, path: string): boolean {
    return this.routes?.resolve(method, path) !== undefined;
  }

  /** A replay sent by the module itself: must be let through untouched. */
  isReplay(headers: { get(name: string): string | null } | undefined): boolean {
    return headers?.get(REPLAY_HEADER) !== null && headers?.get(REPLAY_HEADER) !== undefined;
  }

  isAlwaysOnline(path: string): boolean {
    return this.onlineOnly.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  isWrite(method: string): boolean {
    const m = method.toUpperCase();
    return m !== 'GET' && m !== 'HEAD';
  }

  isForbidden(method: string, path: string): boolean {
    if (this.isWrite(method)) return true;
    if (this.isAlwaysOnline(path)) return true;
    return this.belongsToModule(method, path);
  }

  paths(): DeclaredPath[] {
    return this.routes?.paths() ?? [];
  }
}

export type { DeclaredPath, EntitiesDeclaration };
