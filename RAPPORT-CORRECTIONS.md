# Rapport de correction — intégration réelle du module dans production-core-main

Ce document liste, dans l'ordre où elles ont été trouvées, chaque panne
rencontrée en branchant `@ksm/offline-sync` sur une vraie application
(`production-core-main`, un site Next.js). Pour chacune : ce qui se
passait à l'écran, le mécanisme exact qui la causait, et ce qui a été
changé pour la faire disparaître.

À la fin : un tableau qui sépare les corrections faites dans le code de
`production-core-main` de celles faites dans ce module, et pour chaque
correction côté frontend, la question « est-ce que ça aurait dû vivre ici,
dans le module, à la place ? » — puis une note sur la pertinence du
module et de son intégration.

---

## 1. Le Service Worker s'enregistre mais ne contrôle rien

**Ce qu'on voyait** : le Service Worker démarre, aucune erreur, mais dès
qu'on coupe le réseau, tout casse (`net::ERR_INTERNET_DISCONNECTED`) sur
toutes les pages testées.

**Le mécanisme** : `navigator.serviceWorker.register("/serwist/sw.js")`
a été appelé sans deuxième argument. Sans lui, le navigateur décide tout
seul de la portée (on dit *scope*) du Service Worker : par défaut, c'est
le dossier où vit le fichier du script, ici `/serwist/`. Le Service
Worker existe bien, tourne bien, mais il ne surveille QUE les requêtes
vers `/serwist/*` — jamais `/material-stock`, jamais `/owner/dashboard`,
jamais aucune vraie page de l'application. `navigator.serviceWorker.controller`
reste `null` sur ces pages-là, et rien ne le signale : pas d'exception,
pas de message dans la console.

**Le correctif** : appeler `register` avec `{ scope: "/" }` en second
argument, ce qui dit explicitement au navigateur « surveille tout le
site, pas seulement ton propre dossier ». Le module fournit maintenant
`registerServiceWorker()`, qui le fait par défaut, plus
`warnIfNeverControlled()`, qui affiche un avertissement dans la console
si, 5 secondes après le chargement, aucun Service Worker ne contrôle
encore la page.

**Où** : le fichier `providers/OfflineSyncWrapper.tsx` de
production-core-main (l'endroit où l'application appelle `register`) —
et, en parallèle, le module lui-même, qui expose maintenant
`registerServiceWorker`/`warnIfNeverControlled` pour que ce piège ne se
reproduise pas ailleurs.

---

## 2. Cinq requêtes réelles, jamais déclarées

**Ce qu'on voyait** : cinq familles de requêtes que l'application
appelle vraiment (soldes de stock matières par agence, emplacements,
soldes de produits finis, configuration produit/matière par type)
n'étaient jamais interceptées hors ligne.

**Le mécanisme** : le fichier `offline-sync.entities.yaml` dit au module
quelle URL correspond à quelle table SQLite locale. Une URL absente de
ce fichier n'est tout simplement jamais regardée par le module — elle
part directement au réseau, comme n'importe quelle requête ordinaire.
Ces cinq routes existaient dans le code de l'application, mais personne
ne les avait ajoutées à ce fichier.

**Le correctif** : les déclarer.

**Où** : `offline-sync.entities.yaml`, dans production-core-main —
un fichier de configuration propre à cette application, pas au module.

---

## 3. Deux tables Postgres de schémas différents, un seul nom une fois généré

**Ce qu'on voyait** : après avoir régénéré le schéma local
(`schema.ts`), une table apparaissait vide ou avec les mauvaises
colonnes, alors que les deux tables Postgres d'origine avaient
chacune de vraies données.

**Le mécanisme** : Postgres range ses tables par schéma —
`stock.stock_balance` et `material_stock.stock_balance` sont deux tables
différentes, mais portent le même nom une fois qu'on retire le préfixe
de schéma. Le code du module qui lit la structure Postgres pour
fabriquer `schema.ts` (`SyncRulesReader.ts`, `AdminSchemaSource.ts`)
rangeait les tables par ce nom court, sans le préfixe — les deux
tables finissaient rangées sous la même clé, et l'une écrasait l'autre.

**Le correctif** : ranger les tables par nom complet (« schéma.table »),
et ne raccourcir en nom court que lorsque ce nom court est vraiment
unique — sinon, le renommer en `schema_table` (par exemple
`material_stock_stock_balance`) pour que les deux restent distinctes.

**Où** : dans le module (`src/init/SyncRulesReader.ts`,
`src/init/AdminSchemaSource.ts`) — un bug du générateur, pas de
l'application qui l'utilise.

---

## 4. `select` et `params` disparaissaient à la génération de `entities.ts`

**Ce qu'on voyait** : une route déclarée avec un `params` (voir bug 12
plus bas) semblait ignorée à l'exécution, comme si elle n'avait jamais
été écrite.

**Le mécanisme** : `offline-sync.entities.yaml` est écrit à la main,
`entities.ts` est fabriqué automatiquement à partir de lui, et c'est
`entities.ts` que l'application importe vraiment. La fonction qui fait
cette fabrication (`loadEntitiesFrom()`, dans `EntitiesFile.ts`) ne
recopiait que quatre champs (`path`, `method`, `joins`, `aggregates`) —
`select` et `params` étaient lus dans le YAML, puis silencieusement
jetés avant d'arriver dans `entities.ts`.

**Le correctif** : recopier aussi `select` et `params`.

**Où** : dans le module (`src/init/EntitiesFile.ts`).

---

## 5. L'enveloppe de réponse du module ne portait pas le même nom que celle du serveur

**Ce qu'on voyait** : une page hors ligne plantait avec
`Cannot read properties of null/undefined (reading 'map')`, ou affichait
un message trompeur (« serveur momentanément injoignable ») alors que la
donnée locale existait bel et bien.

**Le mécanisme** : le client HTTP de l'application (`lib/api/kernel.ts`)
lit toujours `body.data`, parce que c'est la forme que renvoie le vrai
serveur (`{ success, data, message, ... }`). Mais une réponse construite
localement par le module (`serveFromPage`, dans `Bridge.ts`) avait sa
propre forme : `{ ok, source: 'local', payload }`. `body.data` valait
donc `undefined` sur toute réponse locale, même quand la donnée était
bien là dans `payload`.

**Le correctif, en deux temps** :
1. D'abord (additif, pour ne rien casser du chemin normal) :
   `kernel.ts` lisait `.payload` uniquement quand l'en-tête
   `X-Offline-Sync: local-database` était présent, sinon `.data` comme
   avant.
2. Aujourd'hui : renommé le champ du module lui-même, `payload` devient
   `data` (`Bridge.ts`). Les deux enveloppes portent maintenant le même
   nom pour la vraie valeur — le cas particulier dans `kernel.ts` a pu
   être retiré entièrement, `body.data` marche pour les deux.

**Où** : le correctif 1 vivait uniquement dans
`lib/api/kernel.ts` (production-core-main). Le correctif 2 a changé le
module (`src/pwa/Bridge.ts`) — et c'est ce changement-là qui a permis de
supprimer le code ajouté côté application. **Portage réussi**, au sens
fort : pas seulement déplacé dans le module, mais rendu inutile.

---

## 6 et 7. Postgres ne laissait rien passer vers PowerSync

**Ce qu'on voyait** : les schémas `stock` et `material_stock` étaient
invisibles depuis l'API d'administration de PowerSync, puis, une fois
rendus visibles, toujours aucune ligne ne remontait côté client.

**Le mécanisme, en deux étapes distinctes** :
1. PowerSync doit avoir la permission Postgres de lire ces schémas
   (`GRANT`). Sans elle, il ne les voit même pas exister.
2. Le `GRANT` seul ne suffit pas : Postgres ne réplique en direct
   (*logical replication*) que les tables explicitement ajoutées à une
   *publication* (`ALTER PUBLICATION ... ADD TABLE`). Avoir le droit de
   lire une table et être prévenu de ses changements sont deux choses
   séparées.

**Le correctif** : un script SQL pour le `GRANT`, un autre pour ajouter
les tables à la publication (les deux idempotents : sans effet si
rejoués).

**Où** : ni le module, ni l'application — l'infrastructure Postgres
elle-même (`KSM_Kernel_Layer/ops/postgres/powersync-bootstrap.sql`, un
troisième dépôt, celui du serveur).

---

## 8. Le worker de PowerSync ne démarrait jamais sous Turbopack

**Ce qu'on voyait** : le jeton de synchronisation était valide, le
serveur avait les bonnes données prêtes (vérifié en interrogeant
directement `/sync/stream`), mais le navigateur ne se connectait
jamais. Aucun `SharedWorker` n'apparaissait dans les DevTools. Aucune
erreur nulle part.

**Le mécanisme** : `@powersync/web` démarre par défaut un worker via
`new URL('./worker.js', import.meta.url)`. Cette construction ne se
résout correctement que si l'outil qui assemble le site (le *bundler*)
la reconnaît et recopie le fichier visé — c'est le cas de Vite et de
Webpack, pas de Turbopack (l'assembleur utilisé par ce projet). Sous
Turbopack, l'adresse calculée ne mène nulle part : le fichier existe
quelque part dans les sources du paquet, mais pas là où le navigateur va
chercher.

**Le correctif** : pointer explicitement vers le fichier statique que
`@powersync/web` copie déjà lui-même, à l'installation, dans
`public/@powersync/worker.js` — précisément pour ce cas :
```ts
database: { dbFilename, worker: '/@powersync/worker.js' },
sync: { worker: '/@powersync/worker.js' },
```

**Où** : d'abord patché à la main dans
`app/services/offline/init.ts` (production-core-main, un fichier déjà
généré, donc pas régénérable automatiquement). Ensuite reporté dans le
gabarit que le module écrit pour tout nouveau projet
(`src/init/ScaffoldCommand.ts`) — toute application qui lancera
`offline-sync scaffold` à partir de maintenant aura ce correctif dès le
départ.

---

## 9. `initSync()` pouvait construire deux moteurs à la fois

**Ce qu'on voyait** : `[offline-sync] module ready` s'affichait deux
fois par chargement de page.

**Le mécanisme** : `initSync()` est censée tourner une seule fois, mais
rien ne l'empêchait d'être rappelée — en développement, React
« Strict Mode » monte un composant, le démonte, puis le remonte
exprès, pour révéler ce genre de défaut. Le démontage ne peut pas
annuler un `initSync()` déjà en cours (son propre nettoyage ne se
branche qu'une fois `initSync()` terminée) : le deuxième montage relance
`initSync()` pour de vrai, pendant que le premier moteur PowerSync
continue de tourner, oublié, en arrière-plan.

**Le correctif** : `initSync()` garde en mémoire sa propre promesse. Un
deuxième appel renvoie ce qui est déjà en cours, au lieu de reconstruire
un moteur.

**Où** : patché dans `app/services/offline/init.ts`
(production-core-main) et reporté dans le gabarit du module
(`ScaffoldCommand.ts`), même logique que le point 8.

**Précision importante** : ce correctif a été fait en pensant qu'il
expliquait la disparition des données de stock au changement de page
(voir point 10) — l'enquête a montré que non, ce n'était pas lié. Gardé
quand même : c'est une vraie faille séparée, qui aurait fini par causer
un problème un jour ou l'autre.

---

## 10. Les noms de table envoyés par le serveur ne correspondaient plus aux noms attendus par le client

**C'est le bug qui causait le symptôme rapporté : « les données du stock
matières disparaissent, sauf juste après un rechargement complet »**

**Ce qu'on voyait** : en interrogeant directement le moteur PowerSync
du navigateur (`SELECT COUNT(*) FROM material_stock_stock_balance`), la
réponse était `0`, systématiquement, avec `hasSynced: true` et aucune
erreur — alors que le serveur, interrogé directement via `/sync/stream`,
avait bien les 12 lignes attendues. Ce qui donnait l'illusion que « ça
marche parfois » venait d'un tout autre chemin : une requête réseau
directe, en concurrence avec la base locale vide, gagnait la course de
temps en temps.

**Le mécanisme** : quand PowerSync envoie une ligne au client, il
l'accompagne du nom de la table d'origine (l'*object_type*), pour que le
client sache dans quelle table locale la ranger. Ce nom est celui écrit
dans la requête SQL du serveur (`sync-rules.yaml`), moins le préfixe de
schéma — `SELECT * FROM material_stock.stock_balance` devient
`stock_balance` sur le fil. Or `stock.stock_balance` (schéma `stock`) et
`material_stock.stock_balance` (schéma `material_stock`) donnent, une
fois le préfixe retiré, exactement le même nom. C'est justement pour
éviter cette collision que le correctif du point 3 qualifie ces tables
différemment côté client (`material_stock_stock_balance`,
`stock_stock_balance`). Mais rien, côté serveur, n'avait été mis à jour
pour envoyer ce même nom qualifié : le client recevait une ligne pour
une table `stock_balance` qu'il ne connaissait pas, et la jetait sans un
mot.

**Le correctif** : nommer explicitement chaque requête concernée avec un
alias SQL, pour que le nom envoyé corresponde au nom attendu :
```sql
SELECT * FROM material_stock.stock_balance AS material_stock_stock_balance WHERE ...
```
27 lignes touchées au total (`stock.*`, `material_stock.*`,
`inventory.stock_movement`, `product_core.stock_reservation` — toutes
les tables dont le nom court collisionne avec une autre).

**Où** : `KSM_Kernel_Layer/ops/powersync/sync-rules.yaml` — le serveur,
un troisième dépôt, ni le module ni l'application.

---

## 11. Le catalogue produit ne se synchronisait jamais pour une vraie session

**Ce qu'on voyait** : après le correctif du point 10, les QUANTITÉS de
stock restaient bien affichées, mais plus les NOMS des articles
(« Bobinga » n'apparaissait plus, seul l'identifiant technique restait
visible).

**Le mécanisme** : le paquet qui synchronise `product`, `brand` et 24
autres tables (`product_core_tenant`) n'était déclenché que si le jeton
de connexion ne portait AUCUNE organisation
(`WHERE request.jwt() ->> 'oid' IS NULL`). Or l'application choisit
toujours une organisation dès la connexion — ce jeton n'existe jamais en
pratique. Cette garde avait un sens pour les paquets « organisation »/
« agence » plus haut dans le même fichier, qui se partagent des tables à
des niveaux différents et doivent rester mutuellement exclusifs. Ici,
aucune autre règle ne sélectionne ces 26 tables à un autre niveau — rien
avec quoi être exclusif.

**Le correctif** : retirer la garde, sur le modèle du paquet
`referentiel_tenant` du même fichier, qui n'en a pas non plus.

**Où** : même fichier que le point 10 — le serveur.

---

## 12. Un segment de chemin qui filtre, confondu avec l'identifiant de la ligne

**Ce qu'on voyait** : `manufacturing/configuration/product-profile`
composait un `SELECT ... WHERE id = 'product-profile'` — toujours zéro
résultat, `product-profile` n'étant pas un UUID de ligne mais une valeur
de la colonne `item_type`.

**Le mécanisme** : la règle générale du module dit qu'un segment de
chemin comme `{id}` désigne la ligne elle-même. Vrai la plupart du
temps, faux ici : `{type}` sélectionne un SOUS-ENSEMBLE de lignes, pas
une ligne précise. Sans un moyen de le dire explicitement, le module
traitait ce seul segment comme s'il visait l'id.

**Le correctif** : une déclaration `params` (segment de chemin → vrai
nom de colonne) dans `entities.yaml`, propagée par le module jusqu'à la
construction du SQL :
```yaml
configuration_item:
  - path: /api/kernel/manufacturing/configuration/{type}
    method: GET
    params: { type: item_type }
```

**Où** : le mécanisme (comprendre `params`) est dans le module
(`EntityRoutes.ts`, `SqlBuilder.ts`, `ComposedOperations.ts`). La
déclaration elle-même (`entities.yaml`) est propre à l'application —
une donnée, pas un comportement, elle ne peut pas vivre ailleurs que là
où on décrit les vraies routes de cette application précise.

---

## 13. Aucune visibilité sur ce que le module faisait réellement

Pas une panne à proprement parler : avant ce correctif, un échec
silencieux (mauvais scope, requête non déclarée, écriture rejetée)
restait invisible tant que personne ne lisait la console à la main.

**Le correctif** : un journal borné d'événements
(`OfflineSync.activity()`/`onActivity()`) et un élément prêt à l'emploi,
`<offline-sync-activity>`, pour l'afficher.

**Où** : mécanisme dans le module (`ActivityLog.ts`, `ui/Activity.ts`) ;
son affichage sur une page de diagnostic dans l'application
(`app/offline-sync/page.tsx`) — chaque application décide où montrer ses
propres diagnostics, ça ne se généralise pas plus que ça dans le module.

---

## 14. `material-stock/movements` : une sixième route jamais déclarée

**Ce qu'on voyait** (trouvé le 20/09/2026, en testant la page
Circularité) : la page affichait « Erreur de connexion. » et les
chiffres précédemment visibles avaient disparu.

**Le mécanisme** : `lib/api/material-stock.ts` appelle
`material-stock/movements` (l'historique des mouvements par matière),
utilisé par la page Circularité — mais cette route n'a jamais été
ajoutée à `entities.yaml`, contrairement à `balances/agency` et
`locations`. Hors ligne, la requête part tout droit au réseau et
échoue ; comme `refresh()` regroupe plusieurs appels et attrape l'échec
de façon générique, tout l'écran retombe sur son état vide initial.

**Le correctif** : déclarer la route. `productId` (paramètre de
requête) correspond déjà à la colonne `product_id` de la table — aucun
`params` supplémentaire nécessaire, contrairement au point 12.

**Où** : `offline-sync.entities.yaml`, production-core-main — même
catégorie que le point 2, une déclaration propre à cette application.

---

## 15. La capacité de production : un calcul, pas une table

**Ce qu'on voyait** (trouvé le 20/09/2026, page Fabrication, onglet
« Ressources affectées ») : `net::ERR_INTERNET_DISCONNECTED` sur
`manufacturing/production-orders/capacity/all`, suivi d'un plantage
JavaScript.

**Le mécanisme** : contrairement à toutes les routes précédentes, celle-
ci ne lit pas une table telle quelle — elle demande au serveur de
CALCULER, pour chaque nomenclature, ce qu'il est possible de produire
compte tenu du stock de matières réellement disponible (une
comparaison ligne à ligne entre les composants requis et les quantités
en stock). Le module sait composer du SQL qui LIT une table déclarée ;
il ne sait pas reproduire un calcul métier pareil sans qu'on lui écrive
un gestionnaire dédié (le module le permet — une « operation map » avec
un gestionnaire personnalisé — mais quelqu'un doit encore écrire ce
calcul, localement, en SQLite).

**Pas corrigé.** Ce n'est pas un oubli de déclaration comme les points 2
et 14 : ajouter une ligne dans `entities.yaml` ne suffirait pas, il n'y
a pas de table à désigner. Une vraie correction demanderait d'écrire ce
calcul en SQLite pur, travail propre à cette application (elle seule
connaît la vraie forme d'une nomenclature et d'un solde de stock).

**Correction (20/09/2026)** : le plantage JavaScript observé juste après
(`Cannot read properties of null (reading 'length')`, suivi de « This
page couldn't load ») n'est PAS lié à la capacité de production — pile
d'appel élucidée depuis, voir le point 17 ci-dessous. Il vient d'un
click séparé, sur l'onglet « Ressources affectées ».

---

## 16. Le pont attendait une connexion réseau pour se brancher

**C'est le bug qui causait le vrai symptôme du départ : des pages
réellement vides en mode hors ligne — pas seulement au changement de
page (réglé au point 10), mais dès qu'on recharge la page pendant que le
réseau est coupé.**

**Ce qu'on voyait** : réseau coupé pour de vrai (pas juste une
navigation interne), rechargement de `/material-stock` — même les
routes déjà déclarées et déjà synchronisées échouaient avec
`net::ERR_FAILED`, alors que la donnée locale existait bel et bien.

**Le mécanisme** : `initSync()` fait deux choses sans rapport l'une
avec l'autre, mais l'une après l'autre au lieu de les faire en même
temps.
1. Préparer la base locale et l'objet qui répond aux questions du
   Service Worker (`OfflineSync.create()`) — ça ne demande rien au
   réseau.
2. Se connecter au serveur pour recevoir les mises à jour et envoyer les
   écritures en attente (`engine.connect(bridge)`) — ça, ça a besoin du
   réseau, et peut prendre du temps.

`initSync()` attendait que l'étape 2 soit TERMINÉE avant de rendre la
main — et `connectBridge()` (celui qui permet au Service Worker de
poser une question à la page) n'était appelé qu'après. Mais le Service
Worker n'attend que 2 secondes une réponse locale avant d'abandonner et
de partir chercher la réponse sur le réseau (`BRIDGE_TIMEOUT_MS`, dans
`Bridge.ts`). Juste après un rechargement, l'étape 2 doit d'abord
essayer de joindre le serveur, échouer, et abandonner formellement —
hors ligne, ça prend souvent plus de 2 secondes. Le Service Worker
demandait une réponse locale à une page qui n'avait pas encore fini de
brancher son écouteur ; il abandonnait, partait vers le réseau, qui
était coupé.

**Le correctif** : ne plus attendre l'étape 2 pour rendre la main.
```ts
const sync = await OfflineSync.create({ /* ... */ });

// Le canal réseau démarre en arrière-plan : la lecture/écriture locale
// n'en a jamais eu besoin. Une connexion ratée est journalisée, jamais
// bloquante.
engine.connect(bridge).catch((err) => {
  logger.error('sync connection failed to establish', { error: String(err) });
});

return sync;
```
`connectBridge()` peut alors se brancher dès que la base locale est
prête, sans attendre un aller-retour réseau qui, hors ligne,
n'aboutit jamais avant la limite du Service Worker.

**Où** : le gabarit du module (`src/init/ScaffoldCommand.ts`) et,
patché à la main pour la même raison qu'aux points 8 et 9,
`app/services/offline/init.ts` dans production-core-main.

**Vérifié en direct**, avec la vraie version installée depuis GitHub
(pas un lien temporaire) : réseau réellement coupé
(`context.setOffline(true)`), rechargement complet de `/material-stock`
— toutes les routes déclarées répondent `x-offline-sync:
local-database` avec de vraies données. Même vérification sur
`/circularity` : le message « Erreur de connexion. » a disparu.

---

## 17. Une déclaration en règle 1 avale un chemin qui n'a rien à voir avec elle

**Ce qu'on voyait** (trouvé le 20/09/2026, onglet « Ressources
affectées », manufacturing) : `Cannot read properties of null (reading
'length')`, puis toute la page tombe (« This page couldn't load »).

**Le mécanisme** : `production_order` est déclarée en règle 1, un
simple préfixe : `/api/kernel/manufacturing/production-orders`. La
règle 1, sans rien préciser de plus, DEVINE le sens de ce qui suit le
préfixe en comptant les segments restants : zéro segment → toute la
liste, un segment → un identifiant de ligne, deux ou plus → le module
ne sait pas répondre et laisse passer au réseau
(`EntityRoutes.ts::resolve`). `manufacturing/production-orders/resources`
laisse exactement UN segment (`resources`) — le module le prend pour un
identifiant, construit `SELECT * FROM production_order WHERE id =
'resources'`, ne trouve rien, répond `null` en croyant avoir bien
répondu. Le composant qui affiche cette liste
(`app/manufacturing/page.tsx`, `ResourceSection`, ligne 395) ne vérifie
pas que la réponse n'est pas `null` avant de lire `.length`.

**Point important** : ce n'est pas une route non déclarée qui échoue
proprement au réseau (comme le point 15) — c'est une route non
apparentée, mal capturée par une déclaration qui ne la concerne pas,
qui répond `null` avec l'air d'avoir réussi. Ça se produit aussi bien en
ligne que hors ligne, dès que le Service Worker contrôle la page.

**Pas corrigé, mais la correction est identifiée** et ne demande aucun
changement du module : déclarer `production_order` en règle 2, chemins
explicites (comme `configuration_item`), qui ne devine jamais :
```yaml
production_order:
  - /api/kernel/manufacturing/production-orders
  - /api/kernel/manufacturing/production-orders/{id}
```
`/resources`, `/capacity`, `/capacity/all`, `/{id}/steps` ne
correspondraient alors plus à rien, et partiraient correctement au
réseau — même traitement que le point 15, pas un plantage silencieux.

**Où** : `offline-sync.entities.yaml`, production-core-main — une
déclaration à corriger, pas un défaut du module.

### Idée de correctif de fond, proposée le 20/09/2026

Plutôt que corriger déclaration par déclaration, l'idée avancée est de
rendre la règle 1 elle-même plus sûre : ajouter dans le YAML un moyen
de dire explicitement, pour un segment de chemin, s'il s'agit d'un
IDENTIFIANT de ligne ou d'une VALEUR DE COLONNE — au lieu de le deviner
en comptant les segments restants. Une partie existe déjà (`params`, en
règle 2, voir point 12) ; ce qui manque, c'est le même genre de
précision pour la règle 1, et un mot explicite pour dire « ceci est un
identifiant » plutôt que de le déduire par défaut. Retenu comme piste
d'amélioration du module, pas encore implémenté.

## 18. Le stock matières hors ligne ne couvre que la lecture, pas encore l'écriture

**Ce qu'on voyait** : dans « Opérations matières », réception
fournisseur et sortie échouent hors ligne
(`POST material-stock/receipts`, `net::ERR_INTERNET_DISCONNECTED`) — à
la différence de Fabrication, où créer un ordre de fabrication hors
ligne fonctionne déjà.

**Pourquoi Fabrication marche et pas ça** : `production_order` (règle
1, voir point 17) couvre TOUTES les méthodes HTTP sur son préfixe, pas
seulement la lecture — créer un ordre de fabrication, c'est un `POST`
sur ce même préfixe, donc déjà pris en charge. `material-stock/receipts`
et `material-stock/issues` ne sont, eux, déclarés nulle part.

**Ce qui rend ça moins simple qu'ajouter une ligne dans `entities.yaml`
(contrairement au point 14)** : le corps envoyé par le formulaire de
réception (`ReceiveInput` : `productId`, `quantity`, `unitCost`,
`currency`, `supplierThirdPartyId`, `referenceNumber`) ne contient PAS
de `movementType` — c'est le vrai serveur qui déduit « RECEIPT » du
chemin `/receipts` appelé, « ISSUE » du chemin `/issues`. Vérifié dans
le module (`SqlBuilder.ts::buildInsert`) : l'écriture locale ne prend
que les colonnes présentes dans le corps de la requête ; sans
`movementType` dans le corps, la colonne `movement_type` serait
simplement omise de l'écriture locale (donc `NULL`, aucune erreur SQL,
**ça ne plante pas**) — la ligne locale, temporaire, serait juste
affichée sans son type jusqu'au prochain passage réseau réussi, qui
remplace cette ligne optimiste par la vraie (l'écriture QUEUED envoie
la requête d'origine complète au vrai serveur, pas la ligne locale
approximative — la donnée durable reste correcte, seul l'affichage
intermédiaire serait incomplet).

**Pas corrigé.** Deux façons de le faire, pas encore choisies : ajouter
`movementType` explicitement dans le corps envoyé par le frontend pour
ces deux appels, ou écrire un vrai gestionnaire personnalisé plutôt
qu'une déclaration automatique.

---

## Ce qui a été trouvé mais volontairement laissé de côté

- **`ProductionDataProvider.tsx`** : `listProductionResources(agencyId)`
  peut aussi renvoyer `null` ailleurs, un appelant fait `.map()` dessus
  sans vérifier — même famille de bug que le point 17, mais dans un
  autre fichier, sans rapport avec `@ksm/offline-sync`.
- **500 sur `product-core/sellable-products`** : bug du serveur
  `product-core`, sans rapport avec la synchronisation hors ligne.

---

## Frontend ou module ? Et qu'est-ce qui aurait dû être porté ?

| # | Correction | A touché | Portable dans le module ? |
|---|---|---|---|
| 1 | Scope du Service Worker | Frontend (`OfflineSyncWrapper.tsx`) + Module | **Déjà fait.** Le module fournit `registerServiceWorker()`/`warnIfNeverControlled()` ; le frontend doit encore choisir de les appeler — un module ne peut pas s'auto-enregistrer à la place de l'application. |
| 2 | 5 routes non déclarées | Frontend (`entities.yaml`) seul | **Non portable, par nature.** C'est une donnée propre à cette application (ses vraies routes), pas un comportement générique. |
| 3 | Collision de noms de table (génération du schéma) | Module seul | — |
| 4 | `select`/`params` perdus à la génération | Module seul | — |
| 5 | Enveloppe `payload` vs `data` | Frontend (`kernel.ts`, workaround temporaire) puis Module (renommage définitif) | **Porté, et mieux que porté** : le renommage dans le module a rendu le correctif frontend inutile, pas seulement déplacé. |
| 6, 7 | GRANT + publication Postgres | Infrastructure (KSM_Kernel_Layer) | Sans objet : ni le module ni le frontend n'ont accès à la configuration Postgres. |
| 8 | Worker PowerSync sous Turbopack | Frontend (`init.ts`, patch à la main) + Module (gabarit) | **Déjà fait pour tout nouveau projet.** Les projets déjà généés avant ce correctif (comme production-core-main) gardent le patch manuel, puisque `offline-sync scaffold` n'écrase jamais un fichier existant. |
| 9 | `initSync()` non idempotent | Frontend (`init.ts`, patch à la main) + Module (gabarit) | **Déjà fait**, même remarque qu'au point 8. |
| 10 | Alias `object_type` (collision sur le fil) | Infrastructure (`sync-rules.yaml`) | Sans objet : le module qualifiait déjà correctement les noms côté client ; le problème vivait entièrement de l'autre côté du fil, dans une configuration serveur que ni le module ni le frontend ne contrôlent. |
| 11 | Garde `oid IS NULL` sur `product_core_tenant` | Infrastructure (`sync-rules.yaml`) | Sans objet, même raison qu'au point 10. |
| 12 | `params` (segment qui filtre) | Module (mécanisme) + Frontend (déclaration) | Le mécanisme est déjà dans le module ; la déclaration ne peut pas l'être, par nature (comme le point 2). |
| 13 | Journal d'activité | Module (mécanisme) + Frontend (où l'afficher) | Le mécanisme est déjà dans le module ; l'endroit où l'afficher est un choix d'application. |
| 14 | `material-stock/movements` non déclarée | Frontend (`entities.yaml`) seul | **Non portable, par nature** — même raison qu'au point 2. |
| 15 | Capacité de production (calcul, pas table) | Ni l'un ni l'autre (pas corrigé) | Si corrigé un jour : gestionnaire personnalisé écrit côté application, en s'appuyant sur un mécanisme du module déjà prévu pour ça (l'« operation map »). Le calcul lui-même resterait propre à cette application. |
| 16 | Le pont attend une connexion réseau pour se brancher | Frontend (`init.ts`, patch à la main) + Module (gabarit) | **Déjà fait**, même remarque qu'aux points 8 et 9. C'est ce correctif-là qui a résolu le symptôme initial (pages vides hors ligne). |
| 17 | `production_order` en règle 1 avale `/resources` | Frontend (`entities.yaml`, pas encore corrigé) | **Non portable au sens strict** (une déclaration reste propre à l'application), mais **la cause est un manque du module** : une déclaration mieux outillée (voir « idée de correctif de fond ») rendrait ce genre d'erreur impossible à écrire, pas seulement facile à corriger une fois trouvée. |
| 18 | Écriture hors ligne pour réception/sortie de stock matières | Ni l'un ni l'autre (pas corrigé) | Pas encore tranché : soit le frontend envoie `movementType` explicitement, soit un gestionnaire personnalisé est écrit — dans les deux cas, une décision d'application, le mécanisme du module (écriture composée, file d'attente) est déjà prêt à l'accueillir. |

**Constat général** : sur 18 corrections, 2 seulement (points 6-7, 10-11
comptés une fois chacun comme « infrastructure ») ne concernaient ni le
module ni l'application — un problème de configuration serveur, en
dehors du périmètre de ce module par nature. Sur les corrections
restantes, la majorité vivait déjà dans le module ou y a été rapatriée ;
ce qui reste côté frontend (déclarations de routes, `params`, emplacement
de l'UI de diagnostic) ne pouvait pas en être autrement, puisque ce sont
des données propres à l'application, pas des défauts du module.

---

## Note : pertinence du module et de son intégration — 8/10

**Ce qui justifie une bonne note** :
- La conception (routage déclaratif, composition SQL à partir d'une
  déclaration de table, file d'attente d'écriture, magasin de rejets
  définitifs, journal d'activité) a tenu la route face à une vraie
  application, avec de vraies données, un vrai backend Spring Boot et un
  vrai serveur PowerSync — pas seulement en tests unitaires isolés.
- La plupart des bugs trouvés (points 3, 4, 8, 9, 16, et la partie
  module du point 5) étaient des défauts du GÉNÉRATEUR ou du MÉCANISME,
  pas de la conception elle-même — une fois corrigés dans le module, ils
  sont corrigés pour TOUTE application qui l'utilisera, pas seulement
  celle-ci. C'est le signe d'une séparation frontend/module qui tient :
  le bon réflexe (« ça devrait vivre dans le module ») était presque
  toujours possible.
- Le point 16 (le vrai bug derrière « pages vides hors ligne ») est le
  meilleur exemple de ce que cette conception rend possible : la cause
  exacte a pu être remontée jusqu'à trois lignes précises d'un seul
  fichier (`initSync()`), le correctif tient en trois lignes de plus, et
  il a été vérifié pour de vrai — réseau réellement coupé, rechargement
  à froid — pas seulement en supposant que ça devait marcher.
- Le module a échoué PROPREMENT face aux deux bugs serveur (points 10,
  11) : il n'a jamais menti, ni affiché de fausses données — il a
  silencieusement refusé une ligne qu'il ne reconnaissait pas. Un module
  qui aurait, à la place, deviné ou forcé un rattachement aurait caché
  le vrai problème au lieu de simplement ne rien afficher.

**Ce qui retient deux points** :
- Deux bugs (points 3, 5) auraient pu être évités par un test qui
  compare vraiment ce qu'envoie un faux serveur PowerSync à ce que
  `schema.ts` déclare attendre — au lieu de tester chaque bout
  séparément. Le silence total en cas de nom de table inconnu (point 10)
  est un choix défendable (ne pas planter), mais rend ce genre de
  problème très long à diagnostiquer : un avertissement de
  `ActivityLog` sur un `object_type` jamais vu aurait raccourci
  l'enquête de plusieurs heures.
- Le point 15 (capacité de production) montre une vraie limite de
  conception, pas un bug : le module ne sait QUE lire des tables. Toute
  fonctionnalité qui calcule quelque chose côté serveur restera hors de
  sa portée tant que personne n'écrit le gestionnaire personnalisé
  correspondant. Ce n'est pas un défaut à corriger — juste une limite à
  garder en tête avant de promettre le mode hors ligne pour ce genre de
  fonctionnalité.
- Le point 16 aurait dû être repéré avant qu'une vraie application ne le
  révèle : pour un module qui se dit « hors-ligne d'abord », faire
  attendre la réponse locale par une étape qui a besoin du réseau est
  exactement le genre d'inversion qu'une relecture de conception, ou un
  test qui coupe vraiment le réseau dès le départ, aurait dû repérer
  avant la mise en situation réelle.
- Le point 17 pointe la même famille de faiblesse que le point 16, côté
  déclaration cette fois : la règle 1 devine le sens d'un segment de
  chemin en comptant ce qu'il en reste, sans savoir si ce qu'elle avale
  a vraiment un rapport avec la table déclarée. Ça a fonctionné pour
  toutes les tables déclarées ainsi jusqu'ici — jusqu'à ce que
  `production_order` ait de vraies sous-routes (`/resources`,
  `/capacity`) qui ne sont pas des identifiants de ligne. L'idée
  proposée en réponse (nommer explicitement identifiant/valeur de
  colonne plutôt que deviner) irait chercher ce genre de bug avant
  qu'une vraie application ne le révèle, comme le point 16 aurait dû
  l'être.
