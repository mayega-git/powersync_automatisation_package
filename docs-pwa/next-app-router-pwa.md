# Guide Complet : PWA et Mode Hors-Ligne avec Next.js (App Router)

Ce document centralise toutes les connaissances nécessaires pour transformer une application Next.js (utilisant App Router) en une Progressive Web App (PWA) robuste, capable de fonctionner entièrement hors-ligne. 

Même un développeur débutant peut suivre ce guide étape par étape pour configurer sa PWA.

---

## ⚠️ Avertissement Crucial : Mode Dev vs Production

**Le mode hors-ligne et les Service Workers sont instables en mode développement (`npm run dev`).** 
Next.js en mode dev compile les pages à la volée, injecte des scripts de rechargement à chaud (HMR) et modifie constamment les hashs des fichiers. Cela rend la mise en cache imprévisible. 
Pour tester le mode hors-ligne, vous devez **TOUJOURS** générer une version de production :
```bash
npm run build
npm run start
```

---

## ⚠️ Avertissement Crucial : la portée (`scope`) du Service Worker

**Un Service Worker enregistré sans `scope` explicite ne contrôle QUE le
répertoire où son script est servi -- jamais le reste de l'application.**
C'est le piège le plus sournois : l'enregistrement réussit, `sw.js` s'active
normalement, mais `navigator.serviceWorker.controller` reste `null` sur
toutes les vraies pages. Aucune exception, aucune erreur console -- le mode
hors ligne semble juste ne jamais s'enclencher, alors que tout le reste (le
pont, `entities.yaml`, `schema.ts`) est correct.

**Cas réel rencontré** : un Service Worker servi à `/serwist/sw.js` sans
`scope` prend par défaut la portée `/serwist/` (le répertoire du script).
Résultat vérifié en Playwright : neuf pages testées, `net::ERR_INTERNET_DISCONNECTED`
sur toutes, hors ligne -- alors que le Service Worker tournait bel et bien.

```ts
// FAUX -- scope implicite, limité au répertoire du script
navigator.serviceWorker.register("/serwist/sw.js")

// CORRECT
navigator.serviceWorker.register("/serwist/sw.js", { scope: "/" })
```

Encore faut-il que le serveur l'autorise : sans en-tête
`Service-Worker-Allowed: /` sur la réponse du script, le navigateur
plafonne quand même la portée demandée au répertoire du script (silencieux
là aussi). Avec `@serwist/turbopack`, cet en-tête est déjà posé
inconditionnellement par `createSerwistRoute` -- rien à faire côté route.
Avec un autre outil de build, vérifiez-le explicitement.

**Recommandé** : plutôt qu'un appel à la main, utilisez
`registerServiceWorker` du module (`@ksm/offline-sync/pwa`), qui applique
`scope: '/'` par défaut :

```ts
import { registerServiceWorker } from "@ksm/offline-sync/pwa"

registerServiceWorker("/serwist/sw.js", { navigator, logger: console })
```

Et connectez le pont (`connectBridge`, voir section 3) même si vous
n'utilisez pas `registerServiceWorker` : il avertit désormais (une fois,
après 5 secondes) si la page n'est contrôlée par aucun Service Worker --
`warnIfNeverControlled`, câblé automatiquement dans `connectBridge`. Ça ne
remplace pas de vérifier `scope`, mais ça transforme un échec silencieux en
avertissement explicite dans la console.

---

## 1. Comprendre le défi : Next.js RSC (React Server Components)

Dans une application classique, le navigateur demande des pages HTML (`mode: 'navigate'`). En mode hors-ligne, le Service Worker (SW) renvoie le HTML depuis le cache.

Avec **Next.js App Router**, lorsque l'utilisateur navigue via un `<Link>`, Next.js ne demande pas du HTML, mais un flux de données spécifique appelé **RSC Payload**. 
- Ces requêtes n'ont pas le `mode: 'navigate'`.
- Next.js ajoute un en-tête `RSC: 1` et un paramètre d'URL dynamique `?_rsc=xyz`.
- **Problème :** Si le SW essaie de chercher `?_rsc=xyz` dans le cache, il ne trouvera rien, car la page a été mise en cache sans ce paramètre dynamique lors du pré-chargement.

---

## 2. Configuration du Service Worker (`sw.ts`)

Pour résoudre cela, le Service Worker doit utiliser un outil comme **Serwist** ou **Workbox** avec des règles de cache spécifiques qui "nettoient" les requêtes RSC avant de chercher dans le cache.

### Stratégies de Cache Recommandées

Voici la configuration complète à utiliser dans votre `sw.ts` pour Next.js :

```typescript
import { NetworkFirst, CacheFirst, StaleWhileRevalidate, ExpirationPlugin, Serwist } from 'serwist';
import { serveFromPage } from '@ksm/offline-sync/pwa';

// 1. Définition des caches
const PAGES_CACHE = 'next-pages-cache';
const STATIC_CACHE = 'next-static-cache';

// 2. Initialisation de Serwist
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      // A. Les requêtes de navigation HTML ET les requêtes RSC
      matcher: ({ request, url }) => {
        return (
          request.mode === 'navigate' ||
          request.headers.get('rsc') === '1' ||
          url.searchParams.has('_rsc')
        );
      },
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE,
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 3600 }),
          {
            // Astuce vitale : On retire le paramètre dynamique _rsc de la requête
            // avant de vérifier le cache. Ainsi, `/ma-page?_rsc=123` cherchera `/ma-page`.
            cacheKeyWillBeUsed: async ({ request }) => {
              const url = new URL(request.url);
              if (url.searchParams.has('_rsc')) {
                url.searchParams.delete('_rsc');
                return new Request(url.href, { ...request, mode: 'cors' });
              }
              return request;
            },
          },
        ],
      }),
    },
    {
      // B. Fichiers statiques, polices, images
      matcher: ({ request, url }) =>
        url.origin === self.location.origin &&
        (request.destination === 'image' || request.destination === 'font' || url.pathname.includes('/_next/static/')),
      handler: new CacheFirst({
        cacheName: STATIC_CACHE,
        plugins: [new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 365 * 24 * 3600 })],
      }),
    }
  ],
});

// 3. Interception par le module Offline Sync
const demanderALaPage = serveFromPage({
  clients: self.clients,
  openChannel: () => new MessageChannel(),
  buildResponse: (corps, init) => new Response(corps, init),
  goToNetwork: (requete) => fetch(requete as Request),
});

self.addEventListener('fetch', (event) => {
  // On laisse le module intercepter les requêtes API (fetch).
  // Si le module ignore la requête, on laisse Serwist (le cache PWA) s'en charger.
  event.respondWith(
    demanderALaPage({ request: event.request, url: new URL(event.request.url) })
      .then((reponse) => {
        if (reponse === undefined) return serwist.handleFetch(event);
        return reponse as Response;
      })
  );
});
```

---

## 3. L'Interception des requêtes métier

### Le pont (Bridge)
Le Service Worker n'a pas accès à SQLite directement. Il utilise un **pont** (`serveFromPage`) pour relayer les requêtes API (les `fetch` de l'application) vers la fenêtre principale du navigateur (le composant React).

### Pourquoi `OfflineSyncProvider` est-il un composant React et non un simple import ?


1. **Agnosticisme de framework** : Le module `@ksm/offline-sync` est conçu en pur TypeScript. Il ne dépend pas de React. Il peut être utilisé avec Vue, Angular, ou Vanilla JS.
2. **Cycle de vie et Session** : L'initialisation de la base de données locale (PowerSync/SQLite) nécessite souvent de connaître l'utilisateur connecté (le token d'authentification). Le composant Provider attend que l'application React ait chargé son `AuthProvider` avant de déclencher `initSync()`.
3. **Persistance du pont** : Le pont (`connectBridge`) utilise un écouteur d'événements `MessageChannel` qui doit exister de manière continue tant que l'utilisateur navigue. Monter un Provider à la racine de l'arbre (`layout.tsx`) garantit que le pont reste ouvert, et qu'il se ferme proprement lors du démontage.

### `OfflineSyncProvider` est déjà écrit -- ne le réimplémentez pas

Le module exporte le composant tout fait, `@ksm/offline-sync/ui`. Il fait
exactement ce que la section précédente décrit (`initSync()` puis
`connectBridge()`, avec `warnIfNeverControlled` câblé) -- inutile de le
réécrire à la main dans l'application.

L'enregistrement du Service Worker, lui, **reste à la charge de
l'application** (le module ne connaît ni votre build, ni où `sw.js` est
servi) : un composant "Wrapper" client minimal fait les deux choses, dans
l'ordre. Exemple réel, tiré d'une intégration en production
(`providers/OfflineSyncWrapper.tsx`) :

```tsx
"use client"

import { useEffect } from "react"
import { OfflineSyncProvider } from "@ksm/offline-sync/ui"
import { registerServiceWorker } from "@ksm/offline-sync/pwa"
import { initSync } from "@/app/services/offline/init"

export function OfflineSyncWrapper({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // scope: '/' par défaut -- voir l'avertissement en tête de ce document.
      registerServiceWorker("/serwist/sw.js", { navigator, logger: console })
    }
  }, [])

  return (
    <OfflineSyncProvider initSync={initSync}>
      {children}
    </OfflineSyncProvider>
  )
}
```

### Ordre de montage dans `layout.tsx`
```tsx
export default function RootLayout({ children }) {
  return (
    <AuthProvider>
      {/* Doit être monté APRÈS l'authentification, mais AVANT les composants qui font des requêtes API --
          le jeton du canal de synchronisation s'obtient contre le cookie/jeton de session. */}
      <OfflineSyncWrapper>
        {children}
      </OfflineSyncWrapper>
    </AuthProvider>
  );
}
```

### Observer ce que le module fait en direct : `<offline-sync-activity>`

Une fois le pont branché, il n'y a par défaut aucune visibilité sur ce qui
se passe -- une requête a-t-elle été servie localement, a-t-elle échoué,
une écriture attend-elle son tour ? Le module expose un flux d'événements
borné (`OfflineSync.activity()`/`onActivity()`) et un élément prêt à
l'emploi pour l'afficher, sur le même patron que `<offline-sync-issues>`
(rejets définitifs) :

```tsx
"use client"
import { useEffect, useRef, useState } from "react"
import { registerActivityElement } from "@ksm/offline-sync/ui"
import { getSyncInstance } from "@/app/services/offline/init"

export default function OfflineSyncActivityPage() {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    registerActivityElement()
    const timer = setInterval(() => {
      const sync = getSyncInstance()
      if (sync && ref.current) {
        ;(ref.current as any).sync = sync
        clearInterval(timer)
      }
    }, 200)
    return () => clearInterval(timer)
  }, [])
  // @ts-expect-error -- custom element, non typé par React
  return <offline-sync-activity ref={ref} />
}
```

Strictement en lecture (comme `<offline-sync-issues>`) : aucune action n'y
est déclenchable, c'est un tableau de bord, pas une console de commande.

---

## 4. Le fichier `entities.yaml` et le formatage des données

### Le mapping sans méthodes
Le fichier `offline-sync.entities.yaml` indique au module quelle URL correspond à quelle table SQLite.
**Règle d'or :** N'ajoutez **aucun préfixe HTTP** (`GET`, `POST`, etc.) dans ce fichier. Le module utilise ces chemins comme des préfixes et intercepte toutes les méthodes HTTP correspondantes de lui-même en les déduisant !
```yaml
  # FAUX : 
  # inventory_balance:
  #   - GET /api/kernel/stock/balances

  # VRAI :
  inventory_balance:
    - /api/kernel/stock/balances
```

### Un segment de chemin qui filtre, pas qui identifie : `params`

La règle simple ci-dessus suppose qu'un segment de chemin (`{id}`) désigne
toujours la ligne elle-même. Ce n'est pas toujours vrai : une route comme
`manufacturing/configuration/{type}` (où `{type}` vaut `product-profile`
ou `material-profile`) ne demande pas la ligne d'id `product-profile` --
elle demande toutes les lignes dont la colonne `item_type` vaut
`product-profile`. Sans le dire explicitement, le module lirait ce segment
comme un id et ne trouverait jamais rien (`WHERE id = 'product-profile'`,
`id` étant un UUID généré).

`params` (forme objet, règle 2 uniquement) fait ce lien explicite,
segment de chemin -> vrai nom de colonne :

```yaml
configuration_item:
  - path: /api/kernel/manufacturing/configuration/{type}
    method: GET
    params: { type: item_type }
  - path: /api/kernel/manufacturing/configuration/{type}
    method: POST
    params: { type: item_type }
  - path: /api/kernel/manufacturing/configuration/{type}/{id}
    method: PUT
    # pas besoin de "params" ici : {id} est déjà lu comme l'id de la ligne,
    # {type} filtre en plus mais sans mapping explicite il est ignoré --
    # acceptable pour un PUT/DELETE ciblé, mais pas pour un GET/POST en liste.
  - path: /api/kernel/manufacturing/configuration/{type}/{id}
    method: DELETE
```

Un segment absent de `params` garde exactement le comportement historique
(dernier segment = id) : rien ne change pour les déclarations qui n'en ont
pas besoin.

### Le formatage des réponses (`offline-formatter.ts`)
En mode hors-ligne (Offline-First), la majorité des données métier proviennent de la base SQLite locale. Or, la structure des tables SQL ne correspond presque jamais parfaitement à ce que vos composants React attendent (attentes de type `camelCase`, colonnes manquantes, champs JSON sérialisés).

Il est **fortement recommandé** d'imposer un formatage strict via un intercepteur (souvent placé dans votre client API comme `kernel.ts` ou `api.ts`), plutôt que d'exposer la logique SQL ou la structure brute de SQLite au frontend.

```typescript
// Exemple de formatage dans lib/api/offline-formatter.ts
export function formatOfflineResponse(path: string, rawData: any[]): any {
  const camelCased = convertToCamelCase(rawData);

  if (path.includes('stock/balances')) {
    // Adapter le modèle SQL au modèle UI attendu
    return camelCased.map(row => ({
      ...row,
      productId: row.organizationProductId // La UI attend productId, SQLite renvoie organizationProductId
    }));
  }
  return camelCased;
}
```

## Résumé
1. **Toujours tester en Production (`npm run build`).**
2. **Enregistrez le Service Worker avec `scope: '/'` explicite**
   (`registerServiceWorker` du module) -- sinon il ne contrôle que son
   propre répertoire, silencieusement.
3. **Nettoyer `?_rsc`** dans les règles de cache du Service Worker.
4. Ne mettez **pas de GET/POST** dans la forme simple de `entities.yaml`
   (règle 1) ; utilisez `params` (règle 2) quand un segment de chemin
   filtre une colonne au lieu de désigner la ligne.
5. Montez `<offline-sync-activity>` (ou au minimum `<offline-sync-issues>`)
   quelque part en développement : un échec silencieux (scope, requête non
   déclarée, rejet définitif) devient visible immédiatement.
6. Gardez le **frontend agnostique** : utilisez un formateur central pour transformer les données SQL brutes en modèles adaptés pour vos composants React, car la BD est la source unique de vérité.
