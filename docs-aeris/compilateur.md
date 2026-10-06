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
| Java | variables, `if`/`else` et retours anticipés **conditionnels** (sémantique exacte : la suite de la méthode ne s'exécute que sur les chemins qui n'ont pas retourné), ternaires, `switch` en flèche, `try/catch` sur conversions, `catch` qui ne fait que relancer (transparent), `for-each` (déroulé sur listes littérales, « premier élément qui retourne » pour les corps à retour conditionnel, `fold` sinon), `for` compté, opérateurs, concaténation (constantes repliées), records (constructeurs compacts), classes (constructeurs, `this(...)`, `super(...)`), classes anonymes, varargs, enums (y compris champs par constante), implémentation de classe prioritaire sur une déclaration d'interface |
| Lombok | `@Data`, `@Value`, `@Getter`, `@Setter`, `@Builder` (+ `@Builder.Default`, `toBuilder`), `@AllArgs/RequiredArgs/NoArgsConstructor`, `@Slf4j` |
| Reactor | `Mono`/`Flux` : `just`, `justOrEmpty`, `empty`, `error`, `defer`, `fromCallable`, `zip`, `map`, `flatMap`, `flatMapMany`, `filter`, `filterWhen`, `switchIfEmpty`, `defaultIfEmpty`, `then*`, `hasElement`, `single`, `zipWith/When`, `collectList`, `count`, `sort`, `take`, `next`, `doOn*` (si sans effet), opérateurs d'ordonnancement ignorés. `Flux.flatMap/concatMap` vers un `Mono` qui lit des données → instruction `EACH` (une recherche par élément, résultats vides écartés). `Mono.onErrorReturn/onErrorResume/onErrorComplete` → instruction `TRY` (le corps force la valeur émise, donc les échecs paresseux sont aussi rattrapés, comme dans Reactor) ; `onErrorX(UneException.class, …)` est prouvé inactif quand rien en amont ne peut lever cette exception du projet |
| Spring Data | `ReactiveCrudRepository`/`R2dbcRepository` (CRUD, requêtes dérivées `findBy…And…OrderBy…`, `count/exists/deleteBy` borné par la clé, `@Query` SQL simple), `R2dbcEntityTemplate` + `Criteria`/`Query`/`Sort`, entités classes ou records, `Persistable#isNew` (exécuté tel quel), `AfterConvertCallback` |
| Bibliothèque | `String`, `UUID`, `Objects`, `Optional`, `List/Set/Map.of`, `Set.copyOf` et `new HashSet<>(c)` (doublons fusionnés, `null` selon Java), `List.getFirst/getLast`, `stream().reduce(identité, f)`, `ArrayList`, `LinkedHashMap`, `LinkedHashSet`, `BigDecimal` (exact, `setScale`/`divide` avec `RoundingMode`), `java.time` (`now()` capturé), `Comparator.comparing…` |
| Erreurs | `ResponseStatusException` (statut, `getReason()`, format exact de `getMessage()`), `@ResponseStatus` sur exceptions, `@RestControllerAdvice` (portée, ordre, gestionnaire le plus proche, **corps d'erreur exact** quand il est calculable). Les échecs détectés par le runtime lui-même (déréférencement de `null`, erreur de liaison, résultat non unique, accès refusé, corps JSON invalide…) reçoivent la réponse du gestionnaire de l'exception Java correspondante (`runtimeErrors`) ; si deux advices non ordonnés la traitent, l'échec est déclaré opaque (`opaqueFailures`) et la requête part au serveur plutôt que d'inventer une réponse |
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
      kind: required                  # required | optional | claim | metadata
      type: yowyob.comops.api.kernel.domain.model.TenantContext
    - method: ReactiveRequestContextHolder.getCorrelation
      kind: metadata                  # métadonnée de requête : présente mais opaque
      type: yowyob.comops.api.kernel.domain.model.RequestCorrelation
  authentication: yowyob.comops.api.kernel.config.ApiKeyAuthenticationToken
inertEffects:                         # comptabilité serveur, rejouée à la réconciliation
  - RecordSystemAuditUseCase.record
  - BusinessEventPublisher.publish
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

### Métadonnée de requête et effets inertes

Deux déclarations traitent ce qu'un appareil ne peut pas reproduire, sans jamais
inventer de valeur. Elles sont **vérifiées par le compilateur**, pas seulement crues.

Une source `kind: metadata` modélise un accesseur de métadonnée de requête
(identifiant de corrélation, adresse d'appel, chemin). Sa valeur est **présente mais
opaque** : en lire la moindre partie est refusé. Un handler qui ne fait que la
transmettre compile ; dès que sa réponse en dépend, l'endpoint reste `UNSUPPORTED`.

`inertEffects` déclare les méthodes dont le seul effet est de la comptabilité serveur
— piste d'audit, journal d'accès, métriques, outbox d'événements. L'appel est modélisé
comme un no-op au lieu d'être analysé, ce qui n'est juste que parce qu'une écriture
hors ligne est rejouée **via l'API du backend** à la réconciliation : c'est le serveur
qui écrit sa ligne d'audit, avec la vraie métadonnée.

Trois garde-fous rendent ces déclarations sûres :

1. **Le compilateur refuse une déclaration sur une méthode qui renvoie une valeur.**
   Seuls `void` et `Mono<Void>` sont acceptés : n'ayant aucune valeur, l'appel ne peut
   pas atteindre la réponse, une décision d'autorisation ou une ligne stockée. Une
   méthode qui répond quelque chose rend l'endpoint `UNSUPPORTED`, avec sa raison.
2. **Une déclaration qui ne correspond à rien n'a aucun effet** (faute de frappe
   incluse) : on perd de la couverture, jamais de la sûreté.
3. **Chaque appel ignoré est inscrit dans l'artefact** en évidence `inert-effect`, avec
   son symbole qualifié et son fichier : un relecteur voit exactement ce que chaque
   endpoint a eu le droit d'ignorer.

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

**Périmètre par parent.** Une entité enfant ne porte souvent aucun claim de session
(lignes d'un document, items d'un bundle, sous-type d'un produit, ressources d'une
prestation). Si **chaque** lecture de cette entité est restreinte à une ligne parente
déjà prouvée — un filtre `colonne = <ligne parente>.<clé>`, ou la même expression de
clé que la lecture parente a utilisée (la forme `GET /parents/{id}/enfants`) — alors
l'enfant est visible exactement quand son parent l'est. Le compilateur l'écrit dans
la projection (`parent: { field, entity }`) au lieu de refuser l'endpoint. La preuve
reste locale à chaque programme : la lecture de la ligne parente est elle-même une
requête vérifiée, et une seule lecture non restreinte de l'enfant suffit à retirer le
périmètre de toute l'entité. Les chaînes sont suivies (petit-enfant), les cycles et
les parents déclarés publics sont rejetés par le validateur d'IR.

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

## Vérification du schéma et contraintes de la base

`--database` compare chaque projection au schéma PostgreSQL réel (tables, colonnes,
types). Une entité dont le mapping diverge rend ses endpoints `UNSUPPORTED`. La Gateway
refuse aussi de démarrer sur un artefact incompatible avec la base.

Les contraintes invisibles dans le code Java sont lues dans `pg_constraint` et
`information_schema` :

- `varchar(n)` et `NOT NULL` sans valeur par défaut sont vérifiés localement : une
  valeur trop longue échoue en `500` comme sur le serveur (divergence trouvée par les
  tests différentiels, puis corrigée) ;
- une écriture touchant une colonne sous clé étrangère, contrainte d'unicité ou
  `CHECK` rend l'endpoint `SPECULATIVE` : seul le serveur peut la valider.

Toujours compiler avec `--database` en CI.

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
