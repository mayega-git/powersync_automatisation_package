# Tests

Une seule commande fait foi :

```bash
npm run test:all      # types + unitaires + intégration, dans cet ordre
```

**La suite d'intégration ne doit jamais être sautée là où son résultat compte.**
C'est le seul endroit où un vrai PostgreSQL, le journal de changements et le cycle complet
écriture hors ligne → réconciliation → convergence s'exécutent ; une suite unitaire verte
qui l'a sautée prouve beaucoup moins qu'il n'y paraît. Sans base de données, elle se saute
pour garder la boucle de développement rapide, mais `AERIS_REQUIRE_INTEGRATION=1` — posé
par `test:all` et par la CI — transforme l'absence de base en **échec** au lieu d'un
silence. La CI (`.github/workflows/verify.yml`) fournit la base en service et rejoue la
chaîne entière à chaque poussée, plus `npm run build`.

| Suite | Commande | Couvre |
|---|---|---|
| Unitaires | `npm test` | IR (validation, signatures), exécuteur, trois stores (même suite de conformité), runtime (hors ligne, remapping, dépendances, conflits, rejeu, rebase, coupe-circuit, fraîcheur, purge, downgrade), politiques, intégration navigateur, compilateur (projets Spring de référence) |
| Intégration | `npm run test:integration` | Gateway + runtime + backend factice sur PostgreSQL réel : exactement-une-fois, refus du proxy ouvert, deltas ordonnés sous commits concurrents, sortie de périmètre |
| Différentiels | `aeris test …` | Même requête, mêmes données : exécuteur local vs backend réel |
| Corpus, différentiel | `npm run corpus:differential` | Les 15 endpoints du second backend, lectures **et** écritures, contre l'application Spring qui tourne |
| Corpus MVC/JPA | `npm run corpus:differential:jpa` | La **même API** sur l'autre pile Spring (MVC, JPA, `ThreadLocal`) : les deux doivent répondre identiquement |
| Corpus, bout en bout | `npm run corpus:e2e` | Écriture hors ligne → outbox → réconciliation → remappage d'identifiants → convergence, contre cette même application |

Les deux dernières sont les seules à confronter le système à une **vraie** application Spring
Boot plutôt qu'à une fixture. Le différentiel compare des réponses ; le test de bout en bout
fait tourner la machinerie que rien d'autre n'exerce — l'outbox, l'ordre des opérations
dépendantes, le remappage des identifiants choisis par l'appareil, et la convergence. Sa
seconde opération est créée **sur le tableau que la première crée**, donc elle porte un
identifiant qui n'existe côté serveur qu'après le rejeu de la première. `AERIS_REQUIRE_CORPUS=1`
y joue le même rôle que `AERIS_REQUIRE_INTEGRATION=1` ailleurs : sans backend, c'est un échec,
pas un silence. Le job CI `differential` enchaîne les deux à chaque poussée.

PostgreSQL jetable pour l'intégration :

```bash
docker run -d --name aeris-gateway-test-pg -e POSTGRES_USER=aeris -e POSTGRES_PASSWORD=aeris \
  -e POSTGRES_DB=aeris -p 127.0.0.1:15433:5432 postgres:16-alpine
npm run test:integration
```

## Tests différentiels (preuve de parité, §18.1)

```bash
npx aeris test --artifact .aeris/aeris-artifact.json \
  --backend http://127.0.0.1:18080 --database postgres://… \
  --token "$JWT" --claims '{"tenantId":"…","organizationId":"…","userId":"…"}' \
  --only '* /api/sales-points**'
```

Un jeton porteur n'est qu'une façon de s'authentifier. Un backend qui lit une clé d'API,
un en-tête de tenant ou un en-tête posé par un proxy de confiance se déclare avec
`--headers` à la place (ou en plus) :

```bash
npx aeris test --artifact .aeris/aeris-artifact.json \
  --backend http://127.0.0.1:18090 --database postgres://… \
  --headers '{"x-workspace-id":"…","x-member-id":"…"}' \
  --claims '{"workspaceId":"…","memberId":"…"}'
```

Pour chaque endpoint local, le harnais charge le snapshot réel de la session depuis
PostgreSQL, choisit des clés réelles (dans le périmètre, hors périmètre, inexistantes),
exécute le programme localement (transaction annulée) et appelle le backend avec les
mêmes identifiants. Il compare statut et corps ; seuls les identifiants générés et les
horodatages capturés sont comparés par leur forme. `--writes` ajoute les mutations
(uniquement sur un environnement jetable). Code de sortie non nul en cas d'écart.

Les claims passés en `--claims` doivent correspondre exactement à ce que le backend
dérive du jeton (tenant, organisation, utilisateur…).

Résultat obtenu sur la copie du backend (session client d'API, **sans utilisateur**) :
294 endpoints de lecture locaux, 291 requêtes comparées, **291 identiques, 0 divergence**.

Ce chiffre doit être lu avec sa limite, car elle est importante : **269 des 291
comparaisons sont des `403` identiques**, et seulement 15 des `200` et 7 des `404`. La
politique métier du backend exige un `userId`, qui ne provient que d'un jeton porteur de
session vérifié (`TenantWebFilter`) ; sans lui, tout refuse. Ce que ces 291 comparaisons
établissent, c'est donc que **l'autorisation compilée refuse exactement comme le
serveur** — un résultat réel, mais qui n'exerce presque pas le chemin de données.

Pour que le différentiel morde vraiment, il faut une session utilisateur portant des
permissions, puis relancer en lecture **et** avec `--writes`. Tant que ce n'est pas
fait, les 296 endpoints `REPLAYABLE`/`SPECULATIVE` gardent un contrat de synchronisation
jamais confronté à des mutations réelles sur le backend : c'est le trou de vérification
le plus important du projet.

## Démonstration de bout en bout sur le backend réel

`example/aeris-real-backend-demo.ts` démarre une Gateway sur la base du backend, un
runtime (SQLite) et déroule : lecture locale hors ligne, création et renommage hors
ligne (réponses `201`/`200` provisoires), endpoint en ligne obligatoire bloqué (`503`),
retour du réseau, rejeu via la Gateway avec `Idempotency-Key`, remapping de
l'identifiant local vers l'identifiant serveur, convergence de la ligne locale sur la
ligne canonique (horodatages serveur compris), outbox vide.

```bash
AERIS_GATEWAY_CONFIG=gateway.yaml AERIS_PUBLIC_KEY=… AERIS_KEY_ID=… \
AERIS_HEADERS='{"x-api-key":"…","x-client-id":"…","x-tenant-id":"…","x-organization-id":"…"}' \
AERIS_CLAIMS='{"tenantId":"…","organizationId":"…"}' \
npx tsx example/aeris-real-backend-demo.ts
```

Résultat obtenu sur la copie Docker du backend `iwm-backend` : la ligne
« Kiosque renommé hors ligne » créée hors ligne existe en base avec l'identifiant
attribué par le serveur, et la projection locale ne contient plus l'identifiant local.
