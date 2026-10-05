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

Résultat obtenu sur la copie du backend : réponses identiques (corps compris) pour
les lectures de points de vente sur données réelles, y compris le `404` sur un
identifiant inconnu. Les autres modules exigent un jeton utilisateur avec permissions
pour être comparés.
