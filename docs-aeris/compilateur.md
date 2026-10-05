# Behavior Compiler (`aeris analyze`)

Le compilateur lit les sources Java **de production** (`src/main/java` de chaque module,
jamais `src/test`), les indexe avec tree-sitter (WebAssembly, aucune compilation native),
puis **exécute symboliquement** chaque handler `@RestController`. Chaque appel est
résolu statiquement (beans Spring, profils actifs, implémentation unique d'un port,
fabriques `@Bean`) et inliné jusqu'aux accès aux données. Le résultat par endpoint est
soit un programme IR, soit une raison précise de rester en ligne.

**Principe : fail-closed.** Toute construction que le compilateur ne sait pas modéliser
*exactement* produit `UNSUPPORTED` avec sa raison et sa localisation. Il n'y a aucune
approximation heuristique ni IA dans le chemin de décision.

## Ce qui est compris

| Domaine | Couverture |
|---|---|
| Routage | `@GetMapping`…`@RequestMapping` (méthodes, tableaux de chemins, constantes), `@ResponseStatus`, refus des routes à regex/joker et à conditions `params`/`headers` |
| Liaison | `@PathVariable`, `@RequestParam` (requis, `defaultValue`), `@RequestBody` (DTO classes/records, `@JsonProperty`, `Mono<T>`), `@ModelAttribute`, paramètres opaques (`ServerHttpRequest` → chemin uniquement, `Authentication` → claims configurés) |
| Validation | `@Valid` + `@NotNull`, `@NotBlank` (trim Java), `@NotEmpty`, `@Size`, `@Min`, `@Max`, `@Positive*`, `@Negative*`, `@DecimalMin/Max`, `@AssertTrue/False`, imbrication `@Valid`. Les autres contraintes rendent l'endpoint `SPECULATIVE` (revalidé par le serveur) |
| Java | variables, `if`/`else` avec retours anticipés, ternaires, `switch` en flèche, `try/catch` sur conversions, `for-each` (déroulé sur listes littérales, `fold` sinon), opérateurs, concaténation, records (constructeurs compacts), classes (constructeurs, `this(...)`, `super(...)`), classes anonymes, varargs, enums (y compris champs par constante) |
| Lombok | `@Data`, `@Value`, `@Getter`, `@Setter`, `@Builder` (+ `@Builder.Default`, `toBuilder`), `@AllArgs/RequiredArgs/NoArgsConstructor`, `@Slf4j` |
| Reactor | `Mono`/`Flux` : `just`, `justOrEmpty`, `empty`, `error`, `defer`, `fromCallable`, `zip`, `map`, `flatMap`, `flatMapMany`, `filter`, `filterWhen`, `switchIfEmpty`, `defaultIfEmpty`, `then*`, `hasElement`, `single`, `zipWith/When`, `collectList`, `count`, `sort`, `take`, `next`, `doOn*` (si sans effet), `onError*` (si rien ne peut échouer en amont), opérateurs d'ordonnancement ignorés |
| Spring Data | `ReactiveCrudRepository`/`R2dbcRepository` (CRUD, requêtes dérivées `findBy…And…OrderBy…`, `count/exists/deleteBy` borné par la clé, `@Query` SQL simple), `R2dbcEntityTemplate` + `Criteria`/`Query`/`Sort`, entités classes ou records, `Persistable#isNew` (exécuté tel quel), `AfterConvertCallback` |
| Bibliothèque | `String`, `UUID`, `Objects`, `Optional`, `List/Set/Map.of`, `ArrayList`, `LinkedHashMap`, `LinkedHashSet`, `BigDecimal` (exact, `setScale`/`divide` avec `RoundingMode`), `java.time` (`now()` capturé), `Comparator.comparing…` |
| Erreurs | `ResponseStatusException`, `@ResponseStatus` sur exceptions, `@RestControllerAdvice` (portée, ordre, gestionnaire le plus proche, **corps d'erreur exact** quand il est calculable) |
| Jackson | propriétés par getters (y compris `isNew()` → `"new"`), records, `@JsonProperty`, `@JsonIgnore`, `@JsonIgnoreProperties` ; `@JsonFormat`, `@JsonSerialize`… refusés |
| Contexte | sources de session déclarées (`context.sources`), jeton `Authentication` configuré (`isAuthenticated`, `getAuthorities`) |
| Autorisation | `@PreAuthorize` compilé en contrôles IR : `hasAuthority`, `hasRole`, `and/or/not`, appels `@bean.méthode(authentication, '…')` exécutés symboliquement |

## Configuration (`aeris.config.yaml`)

`aeris init` propose une configuration à partir des sources ; relisez-la.

```yaml
activeProfiles: [r2dbc]               # profils Spring de production (@Profile)
serverTimeZone: UTC                   # zone JVM, pour LocalDateTime.now()
context:
  sources:                            # méthodes statiques renvoyant la session vérifiée
    - method: ReactiveRequestContextHolder.getRequiredContext
      kind: required                  # required | optional | claim
      type: yowyob.comops.api.kernel.domain.model.TenantContext
  authentication: yowyob.comops.api.kernel.config.ApiKeyAuthenticationToken
idempotency:                          # seulement si le backend déduplique vraiment
  header: Idempotency-Key
  methods: [POST, PUT, PATCH, DELETE]
  paths: ['/api/**']
scopeClaims:                          # propriétés qui limitent une ligne à une session
  tenantId: [tenantId]
  organizationId: [organizationId]
publicEntities: []                    # données de référence partagées par toutes les sessions
onlineOnly: ['POST /api/payments/**'] # jamais hors ligne, quoi qu'en dise l'analyse
requestGates:                         # filtres globaux non analysables (abonnements…)
  - paths: ['/api/treasury/**', '/api/banking/**']
    policy: "claim('services').contains('TREASURY')"
overrides:                            # ne peut que restreindre (ou REPLAYABLE -> LOCAL_WRITE_SAFE)
  'PUT /api/profile': SPECULATIVE
freshness: { LOCAL_READ_SAFE: 86400, SPECULATIVE: 900 }
```

Les claims de session sont les composants du record de contexte (`tenantId`,
`organizationId`, `agencyId`, `userId`…). Le runtime doit fournir les mêmes noms.

## Classification

| Classe | Règle |
|---|---|
| `UNSUPPORTED` | Une construction n'a pas pu être modélisée exactement (raison + fichier:ligne) |
| `ONLINE_REQUIRED` | Effet externe (WebClient, Kafka, mail…), entité sans périmètre de session, lecture dont le résultat serveur peut contenir des lignes hors périmètre, création sans garantie d'idempotence, configuration `onlineOnly` |
| `LOCAL_READ_SAFE` | Aucune écriture ; chaque requête est prouvée bornée au périmètre |
| `REPLAYABLE` | Écritures sans lecture d'état partagé, idempotence garantie (clé backend ou PUT/DELETE naturellement idempotents) |
| `SPECULATIVE` | Écritures dont le résultat dépend de données que d'autres sessions peuvent changer, ou dont une validation n'est vérifiable que côté serveur |

**Preuve de confinement.** Pour chaque requête, le compilateur calcule les égalités
`colonne = claim de session` qu'elle garantit : ses filtres, ou pour une lecture par clé,
le test de la première instruction qui regarde la ligne (le garde 404). Le périmètre
d'une entité est l'intersection des gardes de toutes ses requêtes. Une requête qui ne
le garantit pas rend son endpoint `ONLINE_REQUIRED` : son résultat serveur peut
contenir des lignes que l'appareil n'a pas (et ne doit pas avoir).

## Sorties (`.aeris/`)

- `aeris-artifact.json` : l'IR complet (endpoints, programmes, projections, vecteurs de test).
- `aeris-artifact.signed.json` : l'enveloppe signée servie par la Gateway.
- `aeris-report.json` / `aeris-report.html` : classes, raisons principales, projections.

La version d'artefact n'augmente que si les programmes ou projections changent ; la
version de projection (hash) change quand un appareil doit refaire un snapshot.

## Améliorer la couverture

1. Lire les « raisons principales » du rapport : elles sont triées par nombre d'endpoints.
2. Si la raison est une construction Java raisonnable, étendre le compilateur (chaque
   ajout doit être exact et testé, voir `test/aeris/compiler`).
3. Si la raison est sémantique (effet externe, absence d'idempotence, données non
   bornées), c'est une vraie limite : refactorer le backend ou laisser en ligne.
4. Ne jamais forcer une classe plus permissive : `overrides` ne peut que restreindre.

## Vérification du schéma

`--database` compare chaque projection au schéma PostgreSQL réel (tables, colonnes,
types). Une entité dont le mapping diverge rend ses endpoints `UNSUPPORTED`. La Gateway
refuse aussi de démarrer sur un artefact incompatible avec la base.

## Annotations (optionnelles)

Les sources sont dans `java/aeris-annotations/` (rétention `SOURCE` : aucun impact à
l'exécution). Copiez le package `io.aeris.annotations` dans le backend.

| Annotation | Effet |
|---|---|
| `@AerisOnlineOnly("raison")` (méthode ou contrôleur) | L'endpoint reste en ligne |
| `@AerisOffline(policy = AerisPolicy.SPECULATIVE)` | Plafonne la classe calculée ; ne peut que restreindre (ou passer de `REPLAYABLE` à `LOCAL_WRITE_SAFE`) |
| `@AerisPublic` (entité) | Données de référence partagées par toutes les sessions |
| `@AerisScope("organizationId")` (champ d'entité) | Cette colonne limite les lignes au claim de session indiqué |

Une annotation ne donne jamais l'exécution locale à un endpoint dont le compilateur
n'a pas prouvé la sémantique.

## Porte de non-régression en CI

```bash
npx aeris analyze ./backend --database "$DATABASE_URL" --sign key.pem --key-id aeris-2026
npx aeris diff previous/aeris-artifact.json ./backend/.aeris/aeris-artifact.json --fail-on-regression
```

La commande échoue si un endpoint utilisable hors ligne dans l'artefact précédent ne
l'est plus, en listant la raison.
