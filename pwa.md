# Le Service Worker

## Un seul contrôleur par page

Un Service Worker s'enregistre avec un `scope` : le dossier (et tout ce
qu'il contient) qu'il accepte de contrôler. Pour chaque page, le navigateur
choisit **un seul** Service Worker contrôleur  le plus spécifique dont le
scope couvre cette page  et c'est lui, et lui seul, qui reçoit les
évènements `fetch` de cette page.

Deux Service Workers peuvent très bien vivre dans le même projet (des
scopes différents, par exemple). Mais un Service Worker A ne voit jamais
les requêtes d'une page contrôlée par un Service Worker B. B n'a tout
simplement aucune visibilité sur ce qui se passe côté A.

**Conséquence directe pour ce module** : l'interception des requêtes (le
pont, décrit plus bas) et le cache des pages pour la navigation hors ligne
doivent vivre **dans le même fichier** — celui qui contrôle réellement vos
pages. Les répartir dans deux Service Workers séparés ne marche pas : celui
qui contrôle la page ne fait que l'une des deux choses, jamais les deux.

## Ce qu'il faut, absolument, pour l'interception

Deux appels du module, construits une fois au démarrage du worker :

```ts
import { CacheRules, serveFromPage } from '@ksm/offline-sync/pwa';

const moduleRules = CacheRules.create({ entities });

const askThePage = serveFromPage({
  clients: self.clients,
  openChannel: () => new MessageChannel(),
  buildResponse: (body, init) => new Response(body, init),
  goToNetwork: (req) => fetch(req as Request),
});
```

Puis, **une règle de `runtimeCaching` par méthode HTTP, placée avant vos
propres règles** — l'ordre est le dessin : la première règle qui reconnaît
une requête l'emporte.

```ts
{
  method: 'POST', // répéter pour GET, PUT, PATCH, DELETE
  matcher: ({ request, url }) =>
    !moduleRules.isReplay(request.headers) &&
    moduleRules.belongsToModule(request.method, url.pathname),
  handler: async ({ request, url, event }) =>
    await askThePage({
      raw: request,
      clientId: event.clientId ?? '',
      request: /* voir readRequest() dans sw.ts pour la forme exacte */,
    }),
}
```

Sans cette règle par méthode, une écriture faite hors ligne part
directement au réseau et échoue en silence — c'est le piège le plus facile
à manquer.

## Ce qu'il faut, en plus, pour le cache des pages hors ligne

Une deuxième préoccupation, indépendante de la première : rendre les pages
elles-mêmes consultables hors ligne. Deux pièces.

**Une règle de navigation**, qui garde la dernière version connue de toute
page visitée :

```ts
{
  matcher: ({ request }) => request.mode === 'navigate',
  handler: new NetworkFirst({ cacheName: PAGES_CACHE, networkTimeoutSeconds: 5 }),
}
```

**Un précachage explicite**, seulement pour les pages qui doivent être
disponibles avant même leur première visite — typiquement celles derrière
une connexion, qu'un premier visiteur ne peut pas encore avoir "réchauffées"
en les ouvrant :

```ts
const PAGES_TO_PRECACHE: string[] = []; // ex. ['/dashboard', '/compte']

async function precachePages(): Promise<void> {
  if (PAGES_TO_PRECACHE.length === 0) return;
  const cache = await caches.open(PAGES_CACHE);
  await Promise.all(
    PAGES_TO_PRECACHE.map(async (path) => {
      const response = await fetch(path, { credentials: 'include' });
      if (response.ok) await cache.put(path, response);
    }),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(precachePages());
});
```

Une page déjà visitée une fois est mise en cache automatiquement par la
règle de navigation ci-dessus — `PAGES_TO_PRECACHE` ne concerne que les
pages que personne n'a encore ouvertes sur cet appareil.

## Les deux cas d'usage

**Pas encore de Service Worker.** `npx offline-sync scaffold` écrit
`sw.ts`, à côté de `tokens.ts`/`init.ts`/`pont.ts` : les deux pièces
ci-dessus y sont déjà, prêtes à tourner. Le seul `TO FILL IN` qui reste est
`PAGES_TO_PRECACHE` — laissez-le vide si aucune page ne doit être
disponible avant sa première visite.

**Un Service Worker actif ailleurs dans le projet.** `scaffold` écrit quand
même `sw.ts` au même endroit que les autres fichiers engendrés — il n'y a
aucune configuration pour lui désigner un autre chemin, et il ne touche
jamais un fichier qui existe déjà. Utilisez-le comme référence : copiez les
deux pièces (interception, puis cache des pages) dans votre Service Worker
existant, dans cet ordre, avant vos propres règles — puis supprimez
`sw.ts`, comme n'importe quel gabarit engendré qui ne sert pas.

## Sans Service Worker

`patchFetch` (depuis `@ksm/offline-sync/pwa`) remplace `window.fetch`
directement dans la page. Disponible tout de suite, sans enregistrement,
mais ne voit pas les appels faits via `XMLHttpRequest`, et ne fait rien
pour le cache des pages — cette porte de secours ne couvre que
l'interception.
