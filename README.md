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
arrêtée. Détail complet dans [`INSTALLATION-CLIENT.md`](INSTALLATION-CLIENT.md).


