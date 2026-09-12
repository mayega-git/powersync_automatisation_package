# Installer et configurer le module côté front-end

Ce document décrit ce qu'il faut faire, côté application front-end, pour
brancher `@ksm/offline-sync` sur un moteur de synchronisation déjà installé
(voir `INSTALLATION-BACKEND.md` si ce n'est pas encore le cas — en particulier
la section 4, le endpoint de jeton, dont ce document est le pendant côté
client).

C'est une checklist d'installation, pensée pour être suivie une fois, dans
l'ordre, sur n'importe quel projet front-end (Next.js, ou tout autre outillé
en TypeScript).

---

## Vue d'ensemble : ce qui est engendré, ce qui reste à écrire

Le module s'installe via un CLI en deux commandes composées, qui en enchaînent
six. Chaque étape écrit un fichier — la plupart sont **engendrés et ne se
touchent jamais à la main**. Deux exceptions portent une vraie décision :

```
npx offline-sync setup      powersync + init + schema + scaffold
npx offline-sync build      operations + check + discover
```

| Fichier | Écrit par | À votre charge ? |
|---|---|---|
| `offline-sync.config.yaml` | `init` | oui — remplir les chemins et l'adresse du moteur |
| `.env.sync` | `init` | oui — coller le jeton d'administration |
| `src/services/offline/schema.ts` | `schema` | non — engendré, jamais édité |
| `offline-sync.entites.yaml` | `entites` | oui — mettre un chemin en face de chaque table |
| `offline-sync.operations.md` | `operations` | oui — relire, pas rédiger |
| `offline-handlers.stub.ts` / `offline-map.stub.ts` | `discover` | non — engendrés |
| `tokens.ts` | `scaffold` | **oui — le seul fichier qui connaît votre authentification** |
| `init.ts` | `scaffold` | non — entièrement engendré, six objets dans un ordre imposé |

`setup` s'arrête dès qu'elle bute sur une étape humaine et dit laquelle.
Relancée, elle reprend exactement là où elle s'était arrêtée — aucune des
commandes n'écrase un fichier déjà rempli.

---

## 1. Installer le moteur dans l'application

```bash
npx offline-sync powersync
```

Cinq gestes sans rapport les uns avec les autres, et dont l'oubli ne se
manifeste que dans le navigateur, par une erreur qui ne nomme pas sa cause :

- le paquet du moteur (`@powersync/web`), installé ou aligné sur la version
  éprouvée ;
- les workers WASM, copiés dans `public/`, avec un script `postinstall` pour
  les redéposer à chaque installation ;
- `public/@powersync/` ajouté au `.gitignore` — c'est engendré, jamais
  versionné ;
- le réglage du bundler (`asyncWebAssembly`, `topLevelAwait`, une règle pour
  les fichiers `.wasm`) inséré dans `next.config.ts` s'il existe ;
- `NEXT_PUBLIC_POWERSYNC_URL` déclarée (vide) dans `.env.example`.

Rejouable : sur un projet déjà prêt, elle ne fait rien et le dit. Une version
différente du moteur, elle, n'est pas laissée en place mais **alignée** — deux
versions du moteur dans le même arbre produiraient deux bases locales
distinctes, et l'application en verrait une vide sans la moindre erreur.

---

## 2. Écrire la configuration du module

```bash
npx offline-sync init
```

Écrit deux fichiers qui n'ont pas le même sort :

```yaml
# offline-sync.config.yaml — VERSIONNÉ
routes:
  browser: ["src/lib/api"]      # où vivent les appels du navigateur
httpWrapper:
  jsDocTag: "@offlineSyncCall"  # marqueur utilisé par "check"
powersync:
  adminUrl: "http://localhost:8080"
  buckets: []                    # [] = tout le schéma de l'instance
  tokenEndpoint: "/api/auth/sync-token"
```

```
# .env.sync — IGNORÉ PAR GIT, ajouté au .gitignore par la commande elle-même
PS_ADMIN_TOKEN=<le jeton d'administration du moteur>
```

Les séparer n'est pas un détail : tout mettre dans un seul fichier obligerait
à l'ignorer entièrement, et chaque développeur de l'équipe redécouvrirait la
configuration à zéro. `PS_ADMIN_TOKEN` est le même jeton que celui documenté
côté backend (`INSTALLATION-BACKEND.md`, section 3) — à demander à qui
exploite le moteur, jamais à réinventer côté client.

---

## 3. Engendrer le schéma

```bash
npx offline-sync schema
```

Interroge l'API d'administration du moteur (avec `PS_ADMIN_TOKEN`) et écrit
`src/services/offline/schema.ts` — les vrais noms de tables et de colonnes,
lus directement dans les règles de synchronisation. **C'est la seule commande
qui exige que le moteur soit allumé** ; son résultat est versionné, donc les
suivantes n'en ont plus besoin tant que les règles ne bougent pas.

```
2 table(s) repliquee(s) retenue(s).
  tag_entity       (7 colonne(s))  tenant_data
  category_entity  (7 colonne(s))  tenant_data
```

Fichier engendré, jamais édité — le regénérer plutôt que le corriger.

---

## 4. Déclarer quelle table pour quelles requêtes

```bash
npx offline-sync entites
```

Écrit `offline-sync.entites.yaml`, un nom de table par ligne, à compléter avec
le chemin HTTP qu'elle recouvre :

```yaml
entites:
  tag_entity: /api/education/tags
  category_entity:
    - GET  /api/education/categories
    - POST /api/education/categories
```

Une ligne suffit pour toute une table (forme courte) ; une liste explicite
quand un chemin sort du rang (forme longue). C'est ce fichier qui remplace
l'écriture de handlers à la main : le module compose son SQL au moment de la
requête, directement depuis cette déclaration et le schéma de l'étape 3.

```bash
npx offline-sync check-entites   # confronte la déclaration au schéma et au code
```

---

## 5. Le tableau des opérations, puis la carte

```bash
npx offline-sync build   # operations + check + discover
```

Pour tout ce qui ne passe pas par la déclaration `entites` (des routes qui
touchent plusieurs tables, ou qui appellent un service externe), le module
suit le code pour produire `offline-sync.operations.md`, le vérifie contre ce
même code (`check`, bloquant), puis engendre la carte des opérations et des
gabarits de handlers (`discover`). Détail complet dans
`docs/format-document-operations.md`.

Ce fichier **se relit, il ne se réécrit pas** : une fois qu'il existe, la
commande n'y touche plus. `--force` pour le reconstruire volontairement.

---

## 6. Brancher le module sur le moteur

```bash
npx offline-sync scaffold
```

Deux fichiers, et la coupure entre eux est volontaire :

- **`init.ts`** — le montage. Six objets construits dans un ordre imposé
  (moteur, base locale, carnet des refus, connecteur, pont, module).
  Entièrement engendré : rien à y décider, et c'est pour ça qu'il peut être
  régénéré à chaque montée de version du module sans jamais toucher au fichier
  suivant.
- **`tokens.ts`** — d'où l'application tire ses jetons. Le seul fichier de
  tout le branchement qui connaisse votre authentification, et le seul à
  compléter à la main.

### Compléter `tokens.ts`

C'est le pendant, côté client, du endpoint décrit dans
`INSTALLATION-BACKEND.md` (section 4). Le gabarit engendré ressemble à ceci,
à adapter à votre endpoint réel :

```ts
export class ApplicationTokens implements TokenProvider {
  async getStreamToken(): Promise<string | null> {
    const reponse = await fetch('/api/auth/sync-token', {
      method: 'POST',
      credentials: 'include',   // le cookie de session, s'il y en a un
    });

    if (reponse.status === 401 || reponse.status === 403) return null;
    if (!reponse.ok) throw new Error(`jeton de canal refuse (${reponse.status})`);

    const corps = await reponse.json();
    return corps.token ?? null;
  }

  async refreshStreamToken() {
    return this.getStreamToken();
  }

  async getApplicativeToken(): Promise<string | null> {
    // Bearer : retourner le jeton que l'application utilise déjà pour ses
    // appels normaux.
    // Cookie de session : retourner null — rien à ajouter, le navigateur
    // joint le cookie tout seul sur les requêtes rejouées.
    return null;
  }

  async refreshApplicativeToken() {
    return this.getApplicativeToken();
  }
}
```

**Ce jeton est signé côté serveur avec le secret partagé** (`PS_JWT_SECRET`,
`client_auth.hmac_secret` dans `powersync.yaml` — voir
`INSTALLATION-BACKEND.md`, section 4). Le front-end ne connaît jamais ce
secret et n'en a pas besoin : il reçoit ici un jeton déjà signé, prêt à
présenter au moteur tel quel. Rien à faire d'autre côté client que d'appeler
l'endpoint et de transmettre ce qu'il renvoie.

**La seule subtilité du fichier** : `getStreamToken()` doit distinguer
« pas connecté » (`null`, réponse valable) de « panne » (lever une exception).
Rendre `null` sur une panne ferait passer une coupure réseau pour une
déconnexion, et la synchronisation ne reprendrait jamais toute seule au retour
du réseau — voir `INSTALLATION-BACKEND.md`, section 4, pour la même
distinction vue côté serveur.

### Câbler `initSync()`

`init.ts` exporte `initSync()`. Appelez-la une seule fois, au démarrage,
typiquement dans un fournisseur React monté à la racine de l'application :

```ts
useEffect(() => {
  initSync().then((sync) => {
    // brancher le pont Service Worker, enregistrer le module, etc.
  });
}, []);
```

---

## 7. Reprendre les envois après une reconnexion

Quand une écriture rejouée reçoit un 401 (session expirée pendant que
l'appareil était hors ligne), le module :

- garde la file d'attente intacte — rien n'est perdu ;
- appelle **une seule fois** le callback `onReauthRequired` (déjà câblé par
  `scaffold` dans `init.ts`) ;
- **arrête d'insister** au réseau tant qu'on ne lui dit pas que c'est réglé.

À votre charge : appeler `sync.resumeUploads()` dès qu'une session valide
réapparaît côté application — typiquement dans un `useEffect` qui observe
votre état de connexion :

```ts
useEffect(() => {
  if (sync !== null && session !== null) sync.resumeUploads();
}, [sync, session]);
```

Sans cet appel, le module finit par réessayer de lui-même au prochain cycle
naturel du moteur, mais ça peut prendre un moment.

---

## 8. Brancher le pont, côté Service Worker (facultatif)

Si l'application utilise un Service Worker (recommandé — c'est lui qui
attrape toutes les requêtes, quel que soit le code qui les émet), deux
imports depuis `@ksm/offline-sync/pwa` suffisent, côté worker et côté page.
Détail complet dans `docs/architecture.md`. Sans Service Worker, le module
propose une porte de secours (`patchFetch`) qui remplace `window.fetch` — moins
complet (ne voit pas `XMLHttpRequest`), mais disponible immédiatement, sans
aucun enregistrement préalable.

---

## 9. Récapitulatif — tout ce qu'il faut avoir réuni

| Paramètre | Où il sert | Vient de |
|---|---|---|
| `powersync.adminUrl` | `offline-sync.config.yaml` | l'adresse du moteur |
| `PS_ADMIN_TOKEN` | `.env.sync` | qui exploite le moteur |
| `powersync.tokenEndpoint` | `offline-sync.config.yaml` | votre propre endpoint (section 4 de `INSTALLATION-BACKEND.md`) |
| `PS_JWT_SECRET` | **jamais côté client** — reste sur le backend, qui signe le jeton avant de le renvoyer | le même secret que `client_auth.hmac_secret` côté moteur |
| déclaration `entites` | `offline-sync.entites.yaml` | vos tables répliquées + leurs chemins HTTP |
| `getStreamToken()` | `tokens.ts` | appelle `tokenEndpoint`, retourne le jeton signé par le backend |
| `getApplicativeToken()` | `tokens.ts` | `null` (cookie) ou le jeton Bearer déjà utilisé par l'application |
| `onReauthRequired` / `resumeUploads()` | `init.ts` (généré) / votre UI (à écrire) | le cycle de reconnexion |

Les trois premières lignes se règlent une fois. Les deux suivantes sont la
seule vraie décision de conception à prendre côté client — tout le reste
(schéma, carte des opérations, montage) est engendré mécaniquement une fois
qu'elles sont posées.

---

## 10. Ordre de vérification recommandé

1. **`npx offline-sync powersync`** rejouée → doit afficher `=` partout, rien
   à faire deux fois.
2. **`schema`** → le nombre de tables retenues correspond à ce qui est
   attendu.
3. **`getStreamToken()` appelée directement** (hors module, un simple test
   manuel) → décoder le jeton reçu, vérifier qu'il porte les mêmes claims que
   ceux attendus par les règles de synchronisation côté serveur.
4. **`sync.handles(requete)`** sur une requête connue → `true` pour un chemin
   déclaré dans `entites`, `false` sinon. Une déclaration mal orthographiée ne
   lève jamais d'erreur — elle rend silencieusement `false`, et la requête
   part au réseau comme si le module n'existait pas.
5. **Interface de diagnostic du moteur**, avec le jeton obtenu à l'étape 3 →
   confirme que la donnée descend vraiment jusqu'à SQLite, pas seulement que
   le canal s'ouvre.

Le point commun avec le document backend : la plupart des pannes de ce module
ne lèvent aucune erreur. Elles se manifestent par une base locale vide, un
`handles()` qui répond `false`, ou une file qui ne se vide jamais. Vérifier
dans cet ordre isole la cause au lieu de la deviner.
