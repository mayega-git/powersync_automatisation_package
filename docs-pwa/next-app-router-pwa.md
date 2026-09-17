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

### Ordre de montage dans `layout.tsx`
```tsx
export default function RootLayout({ children }) {
  return (
    <AuthProvider>
      {/* Doit être monté APRÈS l'authentification, mais AVANT les composants qui font des requêtes API */}
      <OfflineSyncProvider>
        {children}
      </OfflineSyncProvider>
    </AuthProvider>
  );
}
```

### Code de construction du composant `OfflineSyncProvider`
Voici l'implémentation type du Provider que vous devez intégrer dans votre projet (ex: `app/providers/OfflineSyncProvider.tsx`) :

```tsx
'use client';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { connectBridge } from '@ksm/offline-sync/pwa';
import { initSync } from '@/app/services/offline/init'; // Fonction qui initialise PowerSync
// import { useAuth } from '@/providers/AuthProvider'; 

const OfflineSyncContext = createContext<{ isReady: boolean }>({ isReady: false });

export function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  // const { user } = useAuth(); // Optionnel : si le sync dépend de l'utilisateur

  useEffect(() => {
    let bridgeCleanup: () => void;
    
    async function startSync() {
      // 1. Initialiser la BD locale
      const syncInstance = await initSync();
      
      // 2. Connecter le Service Worker à cette instance
      bridgeCleanup = connectBridge(syncInstance);
      
      setIsReady(true);
    }

    startSync();

    return () => {
      if (bridgeCleanup) bridgeCleanup();
    };
  }, []); // Ajoutez 'user' aux dépendances si nécessaire

  // Optionnel : afficher un loader tant que la base locale n'est pas prête
  // if (!isReady) return <LoadingScreen />;

  return (
    <OfflineSyncContext.Provider value={{ isReady }}>
      {children}
    </OfflineSyncContext.Provider>
  );
}
export const useOfflineSync = () => useContext(OfflineSyncContext);
```

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
2. **Nettoyer `?_rsc`** dans les règles de cache du Service Worker.
3. Ne mettez **pas de GET/POST** dans `entities.yaml`.
4. Gardez le **frontend agnostique** : utilisez un formateur central pour transformer les données SQL brutes en modèles adaptés pour vos composants React, car la BD est la source unique de vérité.
