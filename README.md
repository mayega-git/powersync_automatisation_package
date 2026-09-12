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

Vérifier sa version : `npm --version`. Mettre à jour : `npm install -g npm@latest`.

## Documentation

- [`INSTALLATION-BACKEND.md`](INSTALLATION-BACKEND.md) — installer et
  configurer le moteur de synchronisation côté serveur.
- [`EXEMPLE-INSTALLATION-BACKEND.md`](EXEMPLE-INSTALLATION-BACKEND.md) —
  exemple concret, avec le code réel de l'endpoint de jeton.
- [`INSTALLATION-CLIENT.md`](INSTALLATION-CLIENT.md) — brancher le module sur
  une application front-end.
