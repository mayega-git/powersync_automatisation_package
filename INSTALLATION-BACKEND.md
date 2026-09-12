# Installer et configurer le moteur de synchronisation côté serveur

Ce document décrit ce qu'il faut faire tourner et configurer **côté backend**
avant qu'une application front-end puisse utiliser `@ksm/offline-sync`. Il ne
parle pas du module lui-même — pour ça, voir `docs/mise-en-route.md` — mais de
tout ce qui doit exister en amont : le moteur de synchronisation, sa base de
données, son interface de diagnostic, et le endpoint que votre backend doit
exposer pour délivrer des jetons.

C'est une checklist d'installation, pensée pour être suivie une fois, dans
l'ordre, sur n'importe quel projet.

---

## Vue d'ensemble : quatre pièces

```
┌──────────────┐      réplication       ┌──────────────────┐
│  PostgreSQL  │ ─────────────────────▶ │  Service de sync  │
│ (votre base) │   (wal_level=logical)  │   (PowerSync)      │
└──────────────┘                        └─────────┬─────────┘
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          │                          │                          │
                 ┌────────▼────────┐       ┌─────────▼────────┐      ┌─────────▼────────┐
                 │  Interface de   │       │   API d'admin.    │      │  Canal de sync    │
                 │   diagnostic     │       │ (schéma + règles) │      │ (vers le navig.)  │
                 └─────────────────┘       └─────────┬─────────┘      └─────────┬─────────┘
                                                       │                          │
                                             jeton d'administration      jeton de canal,
                                             (secret d'exploitation)     émis par VOTRE backend
```

Trois pièces sont fournies par le moteur (le service de synchronisation, son
API d'administration, son interface de diagnostic). Une seule est à écrire par
vous : **le endpoint qui délivre le jeton du canal**. C'est le seul point de
contact entre votre système d'authentification et le moteur.

---

## 1. PostgreSQL — préparer la réplication

Le moteur de synchronisation lit les changements de votre base via la
réplication logique de PostgreSQL. Trois prérequis, à poser une fois :

**a) Activer la réplication logique**, dans `postgresql.conf` ou au démarrage
du conteneur :

```
wal_level = logical
```

Redémarrage de PostgreSQL requis après ce changement — ce n'est pas un
paramètre à chaud.

**b) Créer un rôle dédié à la réplication**, avec le strict nécessaire.
`SELECT` suffit — le moteur ne fait jamais d'écriture sur votre base. Deux
façons de l'accorder, selon ce que vous publiez en (c) :

```sql
CREATE ROLE powersync_role WITH REPLICATION LOGIN PASSWORD '...';

-- table par table, si vous listez explicitement en (c)
GRANT SELECT ON tag_entity, category_entity TO powersync_role;

-- ou tout le schéma d'un coup, si vous publiez par schéma en (c)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync_role;
```

Faites correspondre le périmètre du `GRANT` à celui de la publication —
accorder tout le schéma alors que seules deux tables sont publiées n'est pas
faux, juste inutilement large.

**c) Publier ce qui doit être répliqué** — trois façons, du plus précis au
plus large :

```sql
-- une liste explicite : le contrôle le plus fin, à mettre à jour à chaque
-- nouvelle table à répliquer
CREATE PUBLICATION powersync FOR TABLE tag_entity, category_entity;

-- tout un schéma d'un coup : pratique en développement, ou quand la
-- distinction "répliqué / pas répliqué" se fait au niveau du schéma lui-même
CREATE PUBLICATION powersync FOR TABLES IN SCHEMA public;

-- toute la base : le plus large, réservé aux cas où absolument tout doit
-- pouvoir être répliqué un jour
CREATE PUBLICATION powersync FOR ALL TABLES;
```

`FOR TABLES IN SCHEMA` suit automatiquement les tables créées *après* la
publication dans ce schéma — contrairement à `FOR TABLE`, qui fige la liste au
moment de la commande et exige un `ALTER PUBLICATION ... ADD TABLE` à chaque
nouvelle table. C'est le principal argument pour préférer le schéma à la liste
explicite dès que plusieurs tables sont concernées.

Une table absente de la publication (quelle que soit la méthode choisie) est
invisible pour le moteur, quoi que disent vos règles de synchronisation. À
l'inverse, une table publiée mais non citée dans les règles ne descend
simplement vers aucun appareil — publier n'est pas synchroniser, voir
section 4.

**Vérifier** :

```bash
psql -c "SELECT tablename FROM pg_publication_tables WHERE pubname='powersync';"
psql -c "SELECT slot_name, plugin, active FROM pg_replication_slots;"
```

Le slot de réplication est créé automatiquement par le moteur à sa première
connexion — il n'y a rien à créer à la main ici.

---

## 2. Le service de synchronisation

C'est le conteneur qui fait le travail : il lit le flux de réplication de
PostgreSQL, applique vos règles de synchronisation, et sert le résultat aux
appareils connectés.

```yaml
# docker-compose.yml (extrait)
services:
  sync-engine:
    image: journeyapps/powersync-service:latest
    ports:
      - "8080:8080"
    volumes:
      - ./powersync.yaml:/config/powersync.yaml
      - ./sync-rules.yaml:/config/sync-rules.yaml
    environment:
      PS_ADMIN_TOKEN: "${PS_ADMIN_TOKEN}"
```

Le fichier de configuration principal, `powersync.yaml`, a trois sections qui
vous concernent :

```yaml
replication:
  connections:
    - type: postgresql
      uri: !env PS_DATABASE_URI
      sslmode: prefer

client_auth:
  hmac_secret: !env PS_JWT_SECRET
  audience: ["votre-audience"]

api:
  tokens:
    - !env PS_ADMIN_TOKEN
```

- **`replication.connections`** : comment joindre votre PostgreSQL. `uri`
  accepte la forme complète `postgresql://user:pass@host:5432/db`, ou des
  champs séparés (`hostname`, `port`, `database`, `username`, `password`).
- **`client_auth`** : comment le moteur vérifie les jetons que les appareils
  lui présentent pour ouvrir un canal. Voir section 4 — c'est le point qui
  relie le moteur à votre système d'authentification.
- **`api.tokens`** : la liste des jetons d'administration acceptés. **Absente
  par défaut**, ce qui ferme l'API d'administration (section 3) — sans cette
  section, `offline-sync schema` ne peut jamais fonctionner et échoue en
  `401` sur toutes ses requêtes.

**Vérifier que le service tourne** :

```bash
curl -s localhost:8080/probes/liveness
# {"ready":true,"started":true}
```

`ready:true` veut dire que la connexion à PostgreSQL et le flux de réplication
sont établis. Un `ready:false` persistant signale presque toujours un problème
de connexion à la base, pas un problème de configuration des jetons.

### Les règles de synchronisation

`sync-rules.yaml` décide ce qui part réellement vers un appareil — publier une
table (section 1c) la rend seulement *disponible*, les règles décident qui
reçoit quoi :

```yaml
bucket_definitions:
  tenant_data:
    parameters: SELECT request.jwt() ->> 'tenant_id' AS tenant_id
    data:
      - SELECT * FROM tag_entity WHERE tenant_id = bucket.tenant_id
      - SELECT * FROM category_entity WHERE tenant_id = bucket.tenant_id
```

Deux points qui coûtent cher à découvrir autrement :

- **Chaque requête de données doit consommer tous les paramètres déclarés par
  son paquet.** Un paquet qui déclare `tenant_id` en paramètre ne peut
  regrouper que des tables qui portent effectivement une colonne `tenant_id`.
- **Les règles ne sont pas confrontées au schéma réel au chargement.** Une
  faute de frappe sur un nom de table ou de colonne est acceptée sans erreur,
  et se traduit par un appareil qui ne reçoit rien — sans aucun message pour
  le dire. Le seul contrôle disponible est manuel : charger les règles, ouvrir
  un vrai client, et vérifier qu'une ligne descend pour de vrai.

---

## 3. L'API d'administration

C'est la route que la commande `offline-sync schema` interroge pour savoir
quelles tables sont répliquées et avec quelles colonnes — c'est ce qui évite
de deviner un nom de table depuis un chemin HTTP.

**Elle est fermée par défaut.** Pour l'ouvrir, la section `api.tokens` doit
être présente dans `powersync.yaml` (section 2) :

```yaml
api:
  tokens:
    - !env PS_ADMIN_TOKEN
```

`PS_ADMIN_TOKEN` est une chaîne que vous choisissez vous-même — ce n'est pas
un jeton signé, juste un secret partagé. Traitez-le comme un mot de passe
d'administration : jamais dans un fichier versionné, jamais transmis à un
client.

**Vérifier** :

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/admin/v1/schema \
  -H 'Content-Type: application/json' -d '{}'
# 401 — sans jeton, c'est le comportement attendu

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/admin/v1/schema \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${PS_ADMIN_TOKEN}" -d '{}'
# 200
```

**Ce jeton n'a rien à voir avec l'authentification de vos utilisateurs.** Ne
jamais réutiliser un jeton applicatif à sa place, même si techniquement il
passerait la vérification (même émetteur, même audience) : le service de
synchronisation est un composant tiers dans votre infrastructure, et lui
confier un jeton applicatif reviendrait à lui donner une autorisation valable
sur toute votre API, pas seulement sur l'ouverture d'un canal.

---

## 4. Le endpoint de jeton — ce que VOTRE backend doit exposer

C'est la seule pièce que le moteur ne fournit pas : un endpoint, dans **votre**
backend, qui délivre à un appareil déjà authentifié un jeton que le moteur de
synchronisation acceptera.

**La méthode retenue ici est le secret partagé** (`hmac_secret`), pas un JWKS.
Pour une seule application qui émet ses propres jetons, un secret partagé fait
exactement le même travail sans les frais qui viennent avec un trousseau de
clés : pas d'endpoint `.well-known/jwks.json` à exposer, pas de rotation de
clés à orchestrer, pas de bibliothèque de vérification à tenir à jour côté
moteur. Une seule valeur, générée une fois, partagée entre votre backend et le
moteur — rien de plus.

### Ce que ce jeton doit satisfaire

Le moteur vérifie le jeton présenté par l'appareil contre ce qui est déclaré
dans `client_auth` (section 2), par secret partagé.

```yaml
client_auth:
  hmac_secret: !env PS_JWT_SECRET
  audience: ["mon-audience-powersync"]
```

Le endpoint signe le jeton en HS256 avec ce même secret (`PS_JWT_SECRET`),
partagé entre votre backend et le service de synchronisation — jamais transmis
à un client, jamais versionné. Ce que le endpoint doit produire :

| Champ | Contenu | Remarque |
|---|---|---|
| `sub` | identifiant de l'utilisateur ou de l'appareil | sert à distinguer les connexions dans les journaux du moteur |
| `aud` | doit correspondre exactement à `client_auth.audience` | une valeur qui ne correspond pas fait échouer la connexion sans message clair côté client — première chose à vérifier en cas de canal qui ne s'ouvre jamais |
| `exp` | courte durée de vie (minutes, pas heures) | le module redemande un nouveau jeton à chaque tentative d'ouverture plutôt que de tenter un rafraîchissement — une longue durée de vie n'apporte rien et prolonge la fenêtre d'un jeton volé |
| claims additionnels | ce que **vos** règles de synchronisation lisent via `request.jwt()` | propre à votre schéma de permissions (`tenant_id`, `organization_id`, ce que vous avez déclaré section 2) |

**Le point qui casse tout en silence** : si vos règles de synchronisation
lisent `request.jwt() ->> 'tenant_id'` et que le jeton ne porte pas ce claim,
la valeur lue vaut `null`, la condition du paquet ne s'active jamais, et
**l'appareil ne reçoit rien — sans la moindre erreur, ni côté serveur ni côté
client.** C'est l'échec le plus difficile à diagnostiquer de toute
l'installation : tout répond `200`, tout semble connecté, et la base locale
reste simplement vide. Avant de chercher ailleurs, décodez toujours le jeton
émis et vérifiez à l'œil que les claims attendus par les règles y sont
réellement :

```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

### La réponse HTTP attendue par le module

Le module `@ksm/offline-sync` (via `TokenProvider.getStreamToken()`) appelle
cet endpoint et attend une réponse JSON contenant le jeton — la forme exacte de
l'enveloppe est libre, c'est votre code qui l'écrit des deux côtés. Exemple
minimal :

```json
{ "token": "<jwt>" }
```

**Deux réponses, deux significations, à ne pas confondre :**

- **401 / 403** → l'appareil n'est pas authentifié. Le module traite ça comme
  une réponse normale : aucun canal n'est ouvert, aucune erreur n'est levée.
- **Toute autre erreur** (5xx, timeout, réseau) → une panne. Le endpoint doit
  se comporter comme n'importe quelle route protégée de votre API — le module
  s'attend à voir échouer l'appel (exception ou statut d'erreur), pas à
  recevoir un jeton vide ou un `200` avec un corps creux. Confondre les deux
  fait passer une coupure réseau pour une déconnexion côté client, et la
  synchronisation ne reprend alors jamais toute seule après le retour du
  réseau.

---

## 5. L'interface de diagnostic

Un outil web, séparé du service de synchronisation, qui permet d'inspecter ce
qui est réellement répliqué — les paquets actifs, les tables qu'ils
contiennent, et d'exécuter des requêtes SQL sur les données descendues pour un
jeton donné.

```yaml
services:
  sync-diagnostics:
    image: journeyapps/powersync-diagnostics-app:latest
    ports:
      - "8091:80"
```

Elle ne demande aucune configuration propre : à l'ouverture, elle demande
l'adresse du service de synchronisation et un jeton (celui délivré par votre
endpoint, section 4 — pas le jeton d'administration).

**C'est l'outil de vérification de bout en bout.** Une fois un jeton valide en
main :

1. ouvrir l'interface, coller l'adresse du service et le jeton ;
2. les paquets pour lesquels ce jeton a un accès apparaissent ;
3. ouvrir un paquet, vérifier que les tables attendues y figurent, avec des
   lignes dedans.

Zéro ligne visible ici est **indistinguable** d'une mauvaise configuration :
que la table soit vide, que la règle ne s'active pas faute de claim, ou que la
donnée n'existe simplement pas encore côté PostgreSQL, l'interface montre la
même chose — rien. Avant de conclure à un problème de configuration, vérifiez
toujours qu'il existe au moins une ligne, côté PostgreSQL, censée correspondre
au jeton testé.

---

## 6. Récapitulatif — tout ce qu'il faut avoir réuni

| Paramètre | Où il sert | Exemple |
|---|---|---|
| URI de connexion PostgreSQL | `powersync.yaml` → `replication.connections` | `postgresql://powersync_role:...@db:5432/app` |
| `wal_level=logical` | PostgreSQL | — |
| Publication PostgreSQL | `CREATE PUBLICATION` | liste des tables à répliquer |
| Audience du jeton de canal | `powersync.yaml` → `client_auth.audience` **et** votre endpoint de jeton | doivent être identiques mot pour mot |
| Secret partagé (`PS_JWT_SECRET`) | `powersync.yaml` → `client_auth.hmac_secret` **et** votre endpoint de jeton | même valeur, connue des deux seuls côtés — jamais versionnée, jamais transmise à un client |
| Jeton d'administration | `powersync.yaml` → `api.tokens`, variable `PS_ADMIN_TOKEN` | chaîne choisie par vous, jamais versionnée |
| Adresse du service de sync | configuration du module, côté front (`offline-sync.config.yaml` → `powersync.adminUrl`) | `http://localhost:8080` |
| Endpoint de jeton | code de votre backend, appelé par `TokenProvider` côté module | `POST /api/auth/sync-token` |

Les trois premières lignes se règlent une fois, côté infrastructure. Les deux
suivantes sont le seul point de couplage réel entre votre système
d'authentification et le moteur — tout le reste de l'installation en découle
mécaniquement.

---

## 7. Ordre de vérification recommandé

Dans cet ordre, chaque étape isole une cause différente en cas d'échec :

1. **`curl .../probes/liveness`** → le moteur voit-il PostgreSQL ?
2. **`CREATE PUBLICATION`, côté PostgreSQL** → les bonnes tables sont-elles
   dedans ?
3. **API d'administration** (`curl .../api/admin/v1/schema` avec le jeton
   d'admin) → `offline-sync schema` pourra-t-il tourner ?
4. **Endpoint de jeton** (appel direct, puis décodage du jeton reçu) → les
   claims attendus par les règles sont-ils bien présents ?
5. **Interface de diagnostic**, avec un jeton réel → une ligne descend-elle
   vraiment ?

Sauter une étape ne fait pas gagner de temps : un échec à l'étape 5 sans avoir
vérifié l'étape 4 ressemble à un problème de règles alors que c'est souvent un
claim manquant dans le jeton — deux causes qui produisent exactement le même
symptôme (rien ne descend, aucune erreur).
