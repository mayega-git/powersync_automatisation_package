# Runtime navigateur

## Intégration

### Mode `fetch` (recommandé)

```ts
import { createBrowserRuntime } from '@ksm/offline-sync/aeris';

export const aeris = await createBrowserRuntime({
  gatewayUrl: `${API}/aeris`,
  apiOrigin: API,
  trustedKeys: { 'aeris-2026': PUBLIC_KEY_BASE64 },   // embarquée dans le bundle, jamais téléchargée
  authHeaders: () => ({ authorization: `Bearer ${getToken()}` }),
  session: { context: () => claimsFromToken(getToken()) },
  subjectClaims: ['tenantId', 'userId'],
  policyBeans: { businessAccessPolicy: { hasPermission: (auth, permission) => hasPermission(auth, permission) } },
  readStrategy: 'network-first',
});
```

`window.fetch` est patché pour les URL de `apiOrigin` ; le runtime utilise le `fetch`
d'origine pour ses propres appels. Aucune autre modification du code applicatif.

### Mode Service Worker (applications XHR/axios)

```ts
// sw.ts
import { installAerisServiceWorker } from '@ksm/offline-sync/aeris/sw';
installAerisServiceWorker({ apiOrigin: 'https://api.example.com' });

// page
import { createBrowserRuntime, connectAerisServiceWorker } from '@ksm/offline-sync/aeris';
const { runtime } = await createBrowserRuntime({ ...options, patchFetch: false });
connectAerisServiceWorker(runtime);
```

Le Service Worker intercepte, la page décide et exécute, le Service Worker fait les
appels réseau (jamais interceptés deux fois). Si la page ne répond pas, une mutation
renvoie `504 AERIS_OUTCOME_UNKNOWN` plutôt que d'être renvoyée à l'aveugle.

### Stockage

- `database` : toute base SQLite exposée en `AccessLocalDatabase` (PowerSync web,
  wa-sqlite/OPFS…) ; sinon IndexedDB (une transaction couvre données + outbox).
- `better-sqlite3` est supporté via `BetterSqliteDatabase` (Node, Electron, tests).

## Décision par requête

1. Route inconnue de l'artefact → réseau (transparent).
2. En ligne : lectures `network-first` (ou `local-first`), mutations au réseau avec
   `Idempotency-Key` ; si le réseau tombe en cours de route, exécution locale **avec le
   même identifiant d'opération**.
3. Hors ligne : la classe doit être locale, l'endpoint non désactivé par le manifeste
   de politique, les données synchronisées pour cet artefact et plus jeunes que la
   fraîcheur exigée, la session présente avec les claims requis, les politiques
   d'autorisation décidables et accordées. Sinon : `503` avec `X-AERIS-State: blocked`.

Réponses locales : même statut et même corps que le backend ; en-têtes
`X-AERIS-State: local | provisional` et `X-AERIS-Operation-Id` pour les mutations.

## Autorisations hors ligne

Les `@PreAuthorize` sont **compilés** : le compilateur exécute symboliquement les beans
de politique du backend (par ex. `BusinessAccessPolicy.hasPermission`) et produit des
contrôles IR sur les claims de session (`auth.checks`). Sur le backend `iwm-backend`,
les 424 endpoints locaux protégés par `@businessAccessPolicy…` ont leur politique
entièrement compilée : aucune réimplémentation côté front. La session doit fournir les
autorités accordées dans le claim `authorities` (le claim `permissions` du JWT).

À défaut de contrôle compilé, l'expression est évaluée sur les claims mis en cache :
`hasAuthority`, `hasAnyAuthority`, `hasRole`, `hasAnyRole`, `isAuthenticated`,
`permitAll`, `denyAll`, `and/or/not`, `claim('x').contains('y')`. Les appels de beans
(`@businessAccessPolicy.hasPermission(authentication, 'products:write')`) sont délégués
à `policyBeans`. **Ce qui n'est pas décidable est refusé hors ligne.** Le serveur
réévalue tout au rejeu.

## Synchronisation

- Déclencheurs : démarrage, retour `online`, onglet visible, minuterie (30 s), après
  chaque mutation en ligne ; un seul onglet synchronise (Web Locks, sinon bail en base).
- Envoi par lots, dans l'ordre, une opération n'étant envoyée qu'après celles dont
  elle dépend (identifiants locaux référencés, mêmes lignes touchées).
- Reçus : `COMMITTED` (remapping des identifiants locaux → serveur partout : lignes,
  outbox), `CONFLICT` / `REJECTED` (annulation de l'effet local et des dépendants),
  `RETRY` (backoff exponentiel avec jitter, même identifiant d'opération).
- Données serveur (snapshot, delta) appliquées par **rebase** : annulation des effets
  en attente, application de l'état serveur, ré-exécution déterministe des opérations
  en attente avec leurs valeurs capturées (horloge, identifiants).

## Événements et état

```ts
aeris.runtime.on((event) => {
  // operation (QUEUED/SYNCING/SERVER_COMMITTED/CONFLICT/REJECTED), blocked, local,
  // sync, shadow-mismatch, auth-required, artifact, purged
});
const status = await aeris.runtime.status();      // outbox, curseur, métriques p50/p95
const pending = await aeris.runtime.operations(); // pour afficher « à synchroniser » / conflits
await aeris.runtime.acknowledge(operationId);      // retirer un conflit vu par l'utilisateur
await aeris.runtime.purge();                       // logout : données et opérations effacées
```

Un changement de propriétaire de session (claims de `subjectClaims`) purge
automatiquement les données et opérations de la session précédente.

## Mode shadow

`shadow: true` (ou une fonction par endpoint) exécute localement chaque requête en
ligne dans une transaction annulée et compare avec la réponse serveur ; les écarts
émettent `shadow-mismatch`. C'est la phase « Read shadow » du déploiement progressif.
