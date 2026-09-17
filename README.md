# powersync_automatisation_package

Module offline-first (`@ksm/offline-sync`) : interception des requêtes HTTP,
base locale, rejeu différé, branché sur le moteur de synchronisation
PowerSync.

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
npx offline-sync entities
```

Elle écrit `offline-sync.entities.yaml`, une ligne par table répliquée. Son
rôle : dire au module quelle requête HTTP appartient à quelle table  c'est
sur cette déclaration, et seulement elle, que le module s'appuie pour
intercepter une requête, jamais en devinant depuis le code de l'application.
Une fois les chemins remplis, `npx offline-sync check-entities` confronte la
déclaration au schéma du moteur.

## Dernière étape

```bash
npx offline-sync scaffold
```

Elle écrit quatre fichiers :

- `init.ts`  le montage, entièrement engendré.
- `pont.ts`  le branchement Service Worker ↔ page, entièrement engendré
  lui aussi (rien qui dépende de votre authentification).
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
  côté des trois autres. Un seul `TO FILL IN` concret y reste à votre
  charge : la liste des pages (`PAGES_TO_PRECACHE`) à rendre disponibles
  hors ligne avant même leur première visite — typiquement celles derrière
  une connexion. Si vous avez déjà un Service Worker actif ailleurs dans
  le projet, [`pwa.md`](pwa.md) explique pourquoi un seul
  Service Worker peut contrôler une page à la fois, et dit précisément
  quoi copier de `sw.ts` dans le vôtre.

Si un dossier `app/` existe (App Router Next.js), elle câble aussi, sans
rien demander : la route qui compile `sw.ts` en un vrai programme
téléchargeable, `withSerwist` dans `next.config.*`, et les paquets que ça
demande (`@serwist/turbopack`, `esbuild-wasm`). Il reste, dans tous les
cas, deux choses à faire à la main — [`pwa.md`](pwa.md) dit précisément où
et dans quel ordre :
1. dire au navigateur d'enregistrer le Service Worker au démarrage
   (`SerwistProvider`, ou l'équivalent de votre bibliothèque) ;
2. appeler `initSync()`/`connectBridge()`/`catchUpFirstVisit()` — les trois
   fichiers existent, mais rien ne les appelle tout seul.

