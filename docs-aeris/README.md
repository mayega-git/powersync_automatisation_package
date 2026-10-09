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
   sources Spring Boot — WebFlux/R2DBC (Reactor) **ou** MVC/JPA (bloquant) —, exécute
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

## Ce que ça donne, mesuré

Deux corpus **reproductibles** : la même API sur les deux piles Spring, livrés avec le
projet, compilés à chaque exécution de la suite de tests et confrontés à l'application qui
tourne (`npm run corpus:differential`, `npm run corpus:differential:jpa`).

| Corpus | Pile | Endpoints | Hors ligne | Projections | Différentiel |
|---|---|---|---|---|---|
| `taskly` | WebFlux / R2DBC | 15 | **14** | 3 | 40/40 identiques |
| `taskly-jpa` | MVC / JPA | 15 | **14** | 3 | 41/41 identiques |

Dans les deux cas le seul endpoint restant en ligne appelle un fournisseur de mail : un
effet externe qu'aucun appareil ne doit reproduire. Les deux classent les 15 endpoints
**identiquement** — quand ils divergent, le compilateur prouvait quelque chose sur le
framework et non sur le programme.

### Sur des backends que personne n'a écrits pour AERIS

Trois applications WebFlux/R2DBC indépendantes, avec pour seule configuration ce que
`aeris init` propose de lui-même, sans aucun réglage à la main :

| Fichiers Java | Endpoints | Hors ligne | Projections | Blocage principal |
|---|---|---|---|---|
| 105 | 33 | 1 | 0 | `LocalDateTime.minusDays` (8 endpoints) |
| 359 | 185 | 7 | 0 | sous-classes anonymes (32 endpoints) |
| 326 | 219 | 27 | 8 | `ThreadLocal` comme état partagé (69 endpoints) |

C'est la mesure qui compte, et elle est modeste : **la détection de configuration
généralise, la couverture non**. Sur ces trois backends, `aeris init` a trouvé seul le
porteur de session avec des noms qu'il n'avait jamais vus, mais les blocages dominants
sont des manques de modélisation de bibliothèque, pas des limites sémantiques — chacun
est chiffré, donc chacun est une tâche et non une inconnue. Deux des trois plafonnent par
ailleurs sur leur **propre** modèle de données : aucune de leurs entités ne porte de claim
de session, donc rien n'est confinable sans décision humaine.

À titre d'échelle, AERIS a aussi été exécuté sur un backend privé de 1 953 endpoints :
595 utilisables hors ligne, 205 projections déduites du code et vérifiées contre le schéma
PostgreSQL réel. Aucun de ces backends n'est une référence : une régression se lit dans le
**tableau entier**, jamais dans une seule ligne.

### Ce qui est prouvé, et ce qui ne l'est pas

- **Preuves attachées** : chaque classement porte fichier, ligne et empreinte des sources
  qui l'ont justifié ; chaque refus porte sa raison en clair.
- **Autorisations compilées** : les `@PreAuthorize` sont exécutés symboliquement et
  deviennent des contrôles IR sur les claims. Une politique indécidable laisse l'endpoint
  en ligne — jamais d'approximation d'une décision de sécurité.
- **Écritures vérifiées de bout en bout** sur les corpus : outbox, ordonnancement des
  opérations dépendantes, remappage de l'identifiant choisi par le client, convergence,
  et rejeu qui n'écrit rien de plus (`npm run corpus:e2e`).
- **Ce qui n'est pas prouvé** reste en ligne avec une raison. C'est le principe
  fail-closed : une couverture partielle est sûre, pas cassée.
