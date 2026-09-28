# powersync_automatisation_package

Module offline-first (`@ksm/offline-sync`) : écriture et lecture directes
contre une base locale (SQLite via PowerSync), mise en file pour rejeu
différé des écritures. **Depuis le 2026-09-27, il n'y a plus d'interception**
(pas de Service Worker qui devine ce qu'il doit répondre à partir d'un
fichier déclaratif) : l'application appelle `sync.write()`/`sync.read()`
elle-même, au seul endroit où elle appelle normalement `fetch()`. Voir
« Utiliser le module » plus bas.

## Installation

```bash
npm install --legacy-peer-deps https://github.com/mayega-git/powersync_automatisation_package
```

**`--legacy-peer-deps` est nécessaire avec npm < 10.** Ce paquet déclare des
`peerDependencies`, et les versions de npm antérieures à la 10 ont un bug
connu dans leur résolveur de dépendances (`Cannot read properties of null
(reading 'edgesOut')`) qui fait échouer l'installation d'un paquet git dans ce
cas précis — sans rapport avec un conflit réel de versions.

Avec **npm 10 ou plus récent**, le drapeau n'est plus nécessaire :

```bash
npm install https://github.com/mayega-git/powersync_automatisation_package
```

Vérifier sa version : `npm --version`. Mettre à jour (sans exiger une version
plus récente de Node) : `npm install -g npm@10`.

## Première étape

Une fois installé, dans le projet front-end :

```bash
npx offline-sync setup
```

Elle enchaîne l'installation du moteur, la configuration, la génération du
schéma et le branchement du module — en s'arrêtant, si besoin, pour dire
précisément quoi remplir. Relancer la même commande reprend où elle s'était
arrêtée.

### `.env.sync` : quoi en faire

`setup` écrit `.env.sync` (ignoré par git) avec deux valeurs, qui n'ont
**pas** le même sort :

- `PS_ADMIN_TOKEN`  reste dans `.env.sync`, et nulle part ailleurs. C'est
  le jeton qui ouvre l'API d'administration du moteur, utilisé uniquement
  par la commande `schema` (donc par `setup`, qui l'appelle) pour aller
  chercher le schéma des tables. Il ne doit jamais atteindre le
  navigateur : le copier dans un fichier lu par le front-end serait
  l'exposer à n'importe quel visiteur.
- `NEXT_PUBLIC_POWERSYNC_URL`  l'adresse du moteur, lue par le
  navigateur. **Next.js ne charge jamais `.env.sync`** : il faut copier
  cette seule valeur, telle quelle, dans le fichier d'environnement que
  votre projet charge réellement côté navigateur (le plus souvent
  `.env.local`), sous le même nom. Sans cette copie, `initSync()` échoue
  au démarrage avec `NEXT_PUBLIC_POWERSYNC_URL is empty`.

## Étape suivante

```bash
npx offline-sync scaffold
```

Elle écrit trois fichiers :

- `init.ts`  le montage, entièrement engendré : construit le moteur
  PowerSync, la base locale, le connecteur, et `OfflineSync.create({
  connector, logger })` — sans `entities`/`tableColumns`, il n'y a plus rien
  d'autre à lui passer.
- `tokens.ts`  le seul fichier à remplir à la main. Trois `TO FILL IN`
  précis :
  1. `getStreamToken`  les en-têtes additionnels attendus par votre
     endpoint de jeton de canal, si le cookie de session ne suffit pas.
  2. `getApplicativeToken`  **les en-têtes applicatifs** : le jeton à
     mettre dans l'en-tête `Authorization` envoyé sur les appels normaux
     de l'application à votre serveur métier. `null` si votre application
     s'appuie sur un cookie de session : rien à ajouter dans ce cas, le
     navigateur le joint tout seul.
  3. `refreshApplicativeToken`  le mécanisme de renouvellement de ce
     jeton, si votre application en a un.
- `sw.ts`  un Service Worker minimal, prêt à tourner tel quel, écrit à
  côté des deux autres. Il ne porte aucune logique métier (plus de pont
  Service Worker ↔ page) : seulement la mise en cache de la navigation et
  des assets statiques, pour que l'application se charge hors-ligne. Un seul
  `TO FILL IN` concret y reste à votre charge : la liste des pages
  (`PAGES_TO_PRECACHE`) à rendre disponibles hors ligne avant même leur
  première visite. Si vous avez déjà un Service Worker actif ailleurs dans
  le projet, [`docs-pwa/next-app-router-pwa.md`](docs-pwa/next-app-router-pwa.md) explique pourquoi un seul Service Worker
  peut contrôler une page à la fois, et dit précisément quoi copier de
  `sw.ts` dans le vôtre.

Si un dossier `app/` existe (App Router Next.js), elle câble aussi, sans
rien demander : la route qui compile `sw.ts` en un vrai programme
téléchargeable, `withSerwist` dans `next.config.*`, et les paquets que ça
demande (`@serwist/turbopack`, `esbuild-wasm`). 

Il reste, dans tous les cas, deux choses à faire à la main (une fois le `scaffold` terminé) — [`docs-pwa/next-app-router-pwa.md`](docs-pwa/next-app-router-pwa.md) dit précisément où et dans quel ordre :
1. dire au navigateur d'enregistrer le Service Worker au démarrage
   (`registerServiceWorker`, avec un `scope` explicite — voir
   l'avertissement dans `docs-pwa/next-app-router-pwa.md`) ;
2. Intégrer le `OfflineSyncProvider` dans votre composant racine (il ne fait
   plus qu'appeler `initSync()` et exposer `isReady` — plus de pont à
   connecter).

## Utiliser le module : `write()`/`read()`, au point d'appel

Il n'y a **aucune déclaration séparée** (plus de fichier `entities.yaml`).
L'endroit où votre application appelle normalement `fetch()` (un client API
central, souvent un seul fichier) vérifie d'abord un petit registre que vous
écrivez vous-même — une entrée par requête que vous voulez répondre
localement — et bascule sur `sync.write()`/`sync.read()` si une entrée
correspond et que le module est prêt ; sinon la requête part au réseau,
inchangée.

```ts
// Écriture : le développeur fournit le SQL, la méthode/URL de rejeu, le corps.
const result = await sync.write({
  id: crypto.randomUUID(),
  method: "POST",
  url: "/api/kernel/product-core/attribute-definitions",
  sql: "INSERT INTO attribute_definition (id, name, _metadata) VALUES (?, ?, ?) RETURNING *",
  params: [id, name, id],
  body: { name },
});

// Lecture : le développeur écrit sa propre projection AS camelCase.
const rows = await sync.read({
  sql: "SELECT id, name FROM bill_of_materials WHERE organization_id = ? AND agency_id = ?",
  params: [organizationId, agencyId],
});
```

Voir `docs/implementation/OfflineSync.md` pour l'interface complète et les
préconditions (notamment `trackMetadata: true` sur toute table utilisée avec
`write()`).

**Attention (App Router Next.js)** : Le `OfflineSyncProvider` utilise des hooks React côté client. Vous ne pouvez pas l'importer directement dans votre `layout.tsx` serveur. **APRÈS avoir exécuté la commande `scaffold`** (qui génère le `init.ts`), vous devez créer un Wrapper client :

```tsx
// providers/OfflineSyncWrapper.tsx
"use client"
import { OfflineSyncProvider } from "@ksm/offline-sync/ui"
import { initSync } from "@/app/services/offline/init"

export function OfflineSyncWrapper({ children }: { children: React.ReactNode }) {
  return <OfflineSyncProvider initSync={initSync}>{children}</OfflineSyncProvider>
}
```

Ce wrapper doit ensuite être importé et placé dans votre `layout.tsx`, généralement **à l'intérieur** de votre contexte d'authentification.

