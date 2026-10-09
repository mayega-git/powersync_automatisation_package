# Corpus de validation

Le compilateur a été développé contre **un seul** backend réel. Valider contre un seul
projet ne peut pas révéler ce qu'on y a inconsciemment ajusté : l'architecture peut être
propre, le code sans aucun nom du backend d'origine, et une heuristique rester calée sur
son vocabulaire. C'est arrivé.

`taskly/` est là pour ça : une application de listes de tâches, écrite comme une vraie
application, puis passée au compilateur **sans être retouchée pour lui plaire**. Si elle
échoue, c'est le compilateur qu'on corrige, pas le backend.

`taskly-jpa/` est la **même API** sur l'autre pile Spring : handlers MVC bloquants,
`JpaRepository`, session portée par un `ThreadLocal` qu'un filtre servlet remplit,
`RestClient` au lieu de `WebClient`. Même schéma, mêmes réponses JSON, mêmes chemins.
Les deux doivent donc classer chaque endpoint **identiquement** : quand ils divergent,
le compilateur prouvait quelque chose sur le framework et non sur le programme.

Elle diffère volontairement sur chaque axe qu'on contrôle :

| | backend d'origine | `taskly` |
|---|---|---|
| Vocabulaire de session | `tenantId`, `organizationId` | `workspaceId`, `memberId` |
| Découpage | hexagonal (`port/out`, `adapter/out`) | par fonctionnalité |
| Modules | multi-module Maven | module unique |
| Entités | classes Lombok et records | les deux, répartis autrement |
| Erreurs | `ResponseStatusException` + advice | exceptions métier + advice |
| Réponses | enveloppe `ApiResponse` | DTO nus |
| Idempotence | filtre `Idempotency-Key` | aucun |

Et `taskly-jpa` diffère de `taskly` sur la pile elle-même :

| | `taskly` | `taskly-jpa` |
|---|---|---|
| Web | WebFlux (`Mono`, `Flux`) | MVC (valeurs nues) |
| Persistance | R2DBC (`ReactiveCrudRepository`) | JPA (`JpaRepository`, `Optional`/`List`) |
| Session | Reactor Context (`deferContextual`) | `ThreadLocal` + filtre servlet |
| Entités | records et classes Lombok | classes JPA (`@Entity`, pas de record possible) |
| Effet externe | `WebClient` | `RestClient` |
| Port / base | 18090 / 15434 | 18091 / 15435 |

## Ce qu'il a trouvé

Au premier passage, trois défauts de généricité, tous dans la détection de configuration :

1. Les profils Spring n'étaient lus que pour un projet **multi-module** : le chemin
   cherché supposait `.../src/main/`, donc un module unique ne trouvait jamais son
   `application.yml`.
2. `scopeClaims` était rempli avec `tenantId`/`organizationId` **en dur**, au lieu d'être
   dérivé des identifiants du record de session détecté.
3. Les candidats `inertEffects` n'étaient cherchés que par le **nom de la classe** :
   `ActivityLog.record` passait à travers, là où `AuditService.save` était trouvé.

Il a aussi confirmé que le plus gros blocage restant n'est pas un cas particulier :
charger un enfant par sa clé puis vérifier son parent (`TaskService.byId` ici,
`ProductVariantEntity` là-bas) est un idiome courant, rencontré sur deux backends
indépendants.

## Le faire tourner

C'est une vraie application : Java 21, Spring Boot 3, R2DBC, migrations Liquibase, et un
filtre `Idempotency-Key` qui n'applique qu'une fois une mutation rejouée.

```bash
docker run -d --name taskly-pg -e POSTGRES_USER=taskly -e POSTGRES_PASSWORD=taskly \
  -e POSTGRES_DB=taskly -p 127.0.0.1:15434:5432 postgres:16-alpine
npm run corpus:build                       # mvn package
java -jar test-backends/taskly/target/taskly-0.0.1.jar &
npm run corpus:differential                # lectures ET écritures
npm run corpus:e2e                         # hors ligne -> rejeu -> convergence
```

Et la pile MVC/JPA, sur sa propre base pour que les deux ne se voient jamais :

```bash
docker run -d --name taskly-jpa-pg -e POSTGRES_USER=taskly -e POSTGRES_PASSWORD=taskly \
  -e POSTGRES_DB=taskly_jpa -p 127.0.0.1:15435:5432 postgres:16-alpine
npm run corpus:build:jpa
java -jar test-backends/taskly-jpa/target/taskly-jpa-0.0.1.jar &
npm run corpus:differential:jpa
```

La session est portée par des en-têtes (`x-workspace-id`, `x-member-id`), comme le mode
`trusted-headers` de la Gateway : un test peut donc dire qui appelle, sans jeton.

## Pourquoi c'est le contrôle qui compte le plus

`corpus:differential` est le **seul** endroit où un programme compilé est confronté à une
vraie application Spring Boot plutôt qu'à une fixture. Il exécute chaque endpoint local
des deux côtés, sur les mêmes données, et compare statut et corps — création comprise,
avec le remappage de l'identifiant choisi par le client. Le job `differential` de la CI
le rejoue à chaque poussée.

Une divergence ici est le signal le plus fort du projet : soit le compilateur a mal
modélisé quelque chose, soit le backend ne fait pas ce qu'il prétend.

`corpus:e2e` va plus loin que la comparaison de réponses : il fait tourner la Gateway, le
runtime et l'application ensemble. Une écriture hors ligne part dans l'outbox, puis une
seconde opération est créée **sur le tableau que la première crée** — elle porte donc un
identifiant qui n'existe côté serveur qu'après le rejeu de la première. Au retour du réseau,
il vérifie que les deux sont rejouées dans l'ordre, que la tâche atteint le serveur en
pointant sur l'identifiant *du serveur*, que l'appareil abandonne les identifiants qu'il
avait inventés, et qu'un second rejeu n'écrit rien de plus. C'est la machinerie qu'aucune
fixture n'exerce.

## Ce qu'il a trouvé en devenant exécutable

- Spring Data R2DBC traite `save()` avec un identifiant non nul comme un **UPDATE**. Le
  backend échouait donc à la création — exactement ce qu'AERIS avait compilé
  (`IF isNull(id) INSERT ELSE UPDATE`). Le modèle avait raison ; le backend a été corrigé
  avec les deux idiomes réels : `@Version` sur un record, `Persistable` + callback sur une
  classe.
- Le harnais différentiel chargeait la projection **une seule fois** : ses propres
  mutations rendaient les lectures suivantes incomparables. Il la relit désormais avant
  chaque cas en mode écriture.
- Il envoyait le **même corps** à chaque clé, écrivant la même valeur dans plusieurs
  lignes ; une liste triée sur cette colonne avait alors des égalités dont aucune base ne
  garantit l'ordre. Les valeurs du harnais varient maintenant par requête.

## Ce que la pile MVC/JPA a trouvé

- La règle « même ligne, déjà prouvée » (une relecture par la clé d'une ligne déjà lue)
  propageait les paires de périmètre mais **pas la preuve par le parent**. Côté réactif
  `Task` n'a pas de `@Version`, donc aucune relecture de garde optimiste n'exerçait ce
  chemin : `Task` perdait sa projection dès qu'on en ajoutait une.
- JPA fait du **dirty checking** avant d'écrire : un `save()` qui ne change aucune colonne
  n'émet aucun UPDATE, donc **n'incrémente pas** `@Version`. R2DBC écrit toujours. La
  différence est observable puisque la réponse porte la version ; le différentiel l'a vue
  au premier passage (`$.version: local 1, server 0`).
- `save()` d'une entité détachée est un **merge** en JPA (insert *ou* update), pas un
  update aveugle. Sans `@Version` ni `Persistable#isNew` pour dire lequel, c'est refusé.
- `aeris init` ne reconnaissait ni le porteur de session en `ThreadLocal` rendant un
  enregistrement, ni un filtre d'idempotence écrit pour la pile servlet
  (`OncePerRequestFilter`). Il trouvait donc **zéro** configuration sur ce corpus.
