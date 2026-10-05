# AERIS — offline transparent, compilé depuis le backend

AERIS rend une application web utilisable hors ligne **sans réécrire sa logique
métier côté front**. Le comportement des endpoints est extrait du code du backend
au moment du build, compilé en un programme déterministe et signé, exécuté par le
navigateur quand le réseau manque, puis réconcilié avec le serveur au retour du
réseau. Le serveur reste l'unique source de vérité.

Ce dossier documente l'implémentation livrée dans `@ksm/offline-sync` :

| Document | Contenu |
|---|---|
| [compilateur.md](compilateur.md) | `aeris analyze` : ce que le compilateur Spring Boot comprend, la configuration, la classification, le rapport |
| [runtime.md](runtime.md) | Intégration front (Next.js, Service Worker), sessions, autorisations hors ligne, événements |
| [gateway.md](gateway.md) | Déploiement et exploitation de la Sync Gateway |
| [securite.md](securite.md) | Modèle de menace et garanties |
| [tests.md](tests.md) | Tests unitaires, d'intégration et tests différentiels contre le vrai backend |
| [limites.md](limites.md) | Ce qu'AERIS ne fait pas (volontairement) et pistes d'extension |

## Les trois pièces

```
            build (CI)                                 navigateur                         serveur
┌──────────────────────────────┐          ┌──────────────────────────────┐     ┌─────────────────────────┐
│ aeris analyze                │ artefact │ AerisRuntime                 │     │ Sync Gateway            │
│  Java (tree-sitter)          │  signé   │  routeur + politique         │     │  /aeris/snapshot, delta │
│  → interprétation symbolique ├─────────►│  exécuteur déterministe      │◄───►│  /aeris/reconcile       │
│  → IR + projections + vecteurs│ Ed25519  │  store local (SQLite / IDB)  │     │  journal de changements │
│  → classification + rapport  │          │  outbox transactionnelle     │     │  registre d'idempotence │
└──────────────────────────────┘          └──────────────────────────────┘     └────────────┬────────────┘
                                                                                              │ API publique
                                                                                       backend Spring Boot
```

1. **Behavior Compiler** (`@ksm/offline-sync/aeris/compiler`, CLI `aeris`) — lit les
   sources Spring Boot (WebFlux/R2DBC, Reactor, Lombok, records), exécute
   symboliquement chaque handler et produit pour chaque endpoint soit un
   **programme IR** prouvé, soit une **classe** expliquant pourquoi il reste en ligne.
2. **Runtime navigateur** (`@ksm/offline-sync/aeris`) — intercepte les appels API,
   choisit réseau ou exécution locale, journalise les mutations dans une outbox
   (atomiquement avec leur effet local), synchronise et réconcilie.
3. **Sync Gateway** (`@ksm/offline-sync/aeris/gateway`) — sert l'artefact, les
   snapshots et deltas limités au périmètre de la session, et rejoue les opérations
   exactement une fois via l'API publique du backend.

## Démarrage rapide

```bash
# 1. Configuration proposée à partir des sources (à relire)
npx aeris init ./backend

# 2. Clé de signature (la clé privée reste en CI)
npx aeris keygen --out ./keys --key-id aeris-2026

# 3. Compilation, signature et vérification du schéma réel
npx aeris analyze ./backend --sign ./keys/aeris-2026.private.pem --key-id aeris-2026 \
  --database "$DATABASE_URL"

# 4. Comprendre une décision
npx aeris explain GET /api/sales-points/{id} --artifact ./backend/.aeris/aeris-artifact.json

# 5. Prouver la parité contre le backend réel (environnement jetable)
npx aeris test --artifact ./backend/.aeris/aeris-artifact.json --backend http://127.0.0.1:18080 \
  --database "$DATABASE_URL" --token "$TOKEN" --claims '{"tenantId":"…","organizationId":"…"}'

# 6. Gateway
npx aeris gateway --config gateway.yaml
```

Côté front :

```ts
import { createBrowserRuntime } from '@ksm/offline-sync/aeris';

const { runtime } = await createBrowserRuntime({
  gatewayUrl: 'https://api.example.com/aeris',
  apiOrigin: 'https://api.example.com',
  trustedKeys: { 'aeris-2026': '1q1MLSGt2HGbKadfEsoe0ojGIogVnJ7GuP4g5MGGyiU=' },
  authHeaders: () => ({ authorization: `Bearer ${session.token}` }),
  session: { context: () => session.claims },          // claims décodés du jeton
});
// Les fetch vers apiOrigin passent désormais par AERIS, sans autre changement de code.
```

## Résultat sur le backend réel (copie `iwm-backend`)

Mesures sur la copie du backend (4 389 fichiers Java, 1 953 endpoints), artefact v3 :

| Classe | Endpoints | Sens |
|---|---|---|
| `LOCAL_READ_SAFE` | 220 | Lectures servies localement, prouvées limitées au périmètre de session |
| `REPLAYABLE` | 60 | Écritures sans lecture d'état partagé, rejouées une fois |
| `SPECULATIVE` | 148 | Écritures dépendant de données partagées : provisoires, revalidées par le serveur |
| `ONLINE_REQUIRED` | 182 | Effet externe, lecture non bornée au périmètre, pas d'idempotence… |
| `UNSUPPORTED` | 1 343 | Le compilateur n'a pas pu prouver la sémantique (raison précise dans le rapport) |

- **428 endpoints utilisables hors ligne**, tous accompagnés de preuves (fichier/ligne/hash).
- **160 projections sur 161** déduites du code correspondent exactement au schéma
  PostgreSQL réel ; la 161ᵉ (`tp.crm_action`) diverge réellement du code Java et est
  automatiquement exclue (`aeris analyze --database`).
- **Parité différentielle** vérifiée contre le backend Spring en fonctionnement
  (réponses identiques, corps compris, sur données réelles) — voir [tests.md](tests.md).
- `GET /api/sales-points` est classé `ONLINE_REQUIRED` : le compilateur a détecté que
  ce handler peut renvoyer des lignes d'autres organisations (`findAll()` sans filtre)
  — ce qui est vérifiable sur le backend réel.
