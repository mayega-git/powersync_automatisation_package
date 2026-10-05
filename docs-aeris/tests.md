# Tests

| Suite | Commande | Couvre |
|---|---|---|
| Unitaires | `npm test` | IR (validation, signatures), exécuteur, trois stores (même suite de conformité), runtime (hors ligne, remapping, dépendances, conflits, rejeu, rebase, coupe-circuit, fraîcheur, purge, downgrade), politiques, intégration navigateur, compilateur (projets Spring de référence) |
| Intégration | `npm run test:integration` | Gateway + runtime + backend factice sur PostgreSQL réel : exactement-une-fois, refus du proxy ouvert, deltas ordonnés sous commits concurrents, sortie de périmètre |
| Différentiels | `aeris test …` | Même requête, mêmes données : exécuteur local vs backend réel |

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

Pour chaque endpoint local, le harnais charge le snapshot réel de la session depuis
PostgreSQL, choisit des clés réelles (dans le périmètre, hors périmètre, inexistantes),
exécute le programme localement (transaction annulée) et appelle le backend avec les
mêmes identifiants. Il compare statut et corps ; seuls les identifiants générés et les
horodatages capturés sont comparés par leur forme. `--writes` ajoute les mutations
(uniquement sur un environnement jetable). Code de sortie non nul en cas d'écart.

Les claims passés en `--claims` doivent correspondre exactement à ce que le backend
dérive du jeton (tenant, organisation, utilisateur…).

Résultat obtenu sur la copie du backend (session client d'API, sans utilisateur) :
232 endpoints locaux, 204 requêtes comparées, **204 identiques, 0 divergence** — dont
des `200` avec données réelles (points de vente, vendeurs, plans commerciaux,
portefeuilles, catalogue produit…), des `404` sur identifiants inconnus ou hors
périmètre, et des `403` où la politique compilée refuse exactement comme le serveur.
Avec un jeton utilisateur portant des permissions, les mêmes endpoints sont comparés
sur leurs données.

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
