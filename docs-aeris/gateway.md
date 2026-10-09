# Sync Gateway

Service Node.js sans état (l'état est en base) placé à côté du backend. Il sert
l'artefact signé, les snapshots et deltas restreints au périmètre de la session, et
rejoue les opérations hors ligne via l'API publique du backend.

## Configuration (`gateway.yaml`)

```yaml
listen: { host: 0.0.0.0, port: 8090 }
artifactFile: ./aeris-artifact.signed.json
trustedKeys: { aeris-2026: "${AERIS_PUBLIC_KEY}" }      # clé publique de l'artefact
backend:
  url: http://backend:8080
  forwardHeaders: [authorization, x-api-key, x-client-id, x-agency-id]
database:
  url: "${AERIS_DATABASE_URL}"                            # même PostgreSQL que le backend
  schema: aeris
auth:                                                     # vérifie l'appelant comme le backend
  mode: jwt
  jwksUrl: http://backend:8080/.well-known/jwks.json
  issuer: your-issuer
  claims: { tenantId: tid, organizationId: oid, agencyId: aid, userId: sub, actorId: actor, permissions: permissions }
subjectClaims: [tenantId, userId]                         # propriétaire d'une opération
policy: { disabled: [], freshness: {}, minArtifactVersion: 3 }
cors: { origins: [https://app.example.com] }
limits: { maxBatch: 50, maxBodyBytes: 2097152, deltaPageSize: 1000 }
retentionDays: 30
```

Autres modes d'authentification : `introspection` (appel d'un endpoint backend qui
renvoie l'identité), `trusted-headers` (uniquement derrière un proxy de confiance, exige
`acknowledgeInsecure: true`).

## Démarrage

```bash
npx aeris gateway --config gateway.yaml
```

Au démarrage la Gateway : vérifie la signature de l'artefact, vérifie que chaque
projection correspond au schéma réel (sinon refuse de démarrer), installe de façon
idempotente le schéma `aeris` (journal de changements, déclencheurs, registre).

Le rôle PostgreSQL utilisé doit pouvoir lire les tables projetées et, pour
l'installation, en être propriétaire (création des déclencheurs). On peut aussi
extraire le SQL (`setupSql(artifact)`) et le passer en migration.

## Endpoints

| Route | Rôle |
|---|---|
| `GET /aeris/health` | Base joignable, version d'artefact |
| `GET /aeris/artifact` | Enveloppe signée (`ETag`, `304`) |
| `GET /aeris/policy` | Manifeste : coupe-circuits par endpoint, fraîcheur, version minimale |
| `GET /aeris/snapshot?projection=…` | Lignes du périmètre + curseur, lus dans une même transaction `REPEATABLE READ` |
| `GET /aeris/delta?projection=…&since=…` | Changements depuis le curseur (paginés), `resnapshot: true` si le curseur est trop vieux |
| `POST /aeris/reconcile` | Rejoue un lot d'opérations, renvoie un reçu par opération |

## Garanties

- **Ordre des changements.** Chaque modification d'une table projetée écrit une ligne
  de journal ; son numéro de séquence est attribué **au commit**, sous un verrou
  transactionnel. Un lecteur ne voit jamais le changement N+1 avant le N : aucun
  commit concurrent n'est sauté (test d'intégration dédié).
- **Périmètre.** Snapshot et delta appliquent le filtre de scope de chaque projection
  avec les claims vérifiés de l'appelant ; une ligne qui sort du périmètre est envoyée
  comme suppression.
- **Périmètre par parent.** Une projection `parent` est filtrée par l'appartenance de
  sa colonne aux clés des lignes parentes visibles (chaîne complète). Un parent qui
  **entre** dans le périmètre fait envoyer ses enfants déjà existants, qui n'ont pas
  changé eux-mêmes ; un parent qui en **sort** est envoyé comme suppression, et la
  cascade sur ses enfants est faite par l'appareil, sans une ligne de delta par enfant.
- **Exactement une fois.** Le registre `(sujet, operation_id)` répond aux rejeux avec
  le reçu stocké ; l'appel au backend porte toujours le même `Idempotency-Key`. Une
  opération en cours depuis plus de 2 minutes peut être reprise.
- **Pas de proxy ouvert.** Une opération n'est relayée que si sa méthode et son
  chemin correspondent à la route de l'endpoint qu'elle déclare.
- **Ordre des opérations.** Un lot s'arrête à la première opération à réessayer.

## Exploitation

- Purge horaire du journal au-delà de `retentionDays` ; les clients plus anciens
  refont un snapshot.
- Coupe-circuit sans redéploiement : ajouter l'endpoint à `policy.disabled`.
- Rotation de clé : ajouter la nouvelle clé publique aux `trustedKeys` du front, publier
  l'artefact signé par la nouvelle clé, retirer l'ancienne au déploiement suivant.
- Le verrou de séquence est tenu entre l'attribution et la fin du commit (très court) ;
  il sérialise uniquement les commits qui modifient des tables projetées.
