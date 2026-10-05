# Sécurité

Le navigateur est un environnement non fiable (architecture §14). AERIS n'utilise
jamais une donnée locale comme preuve d'autorisation ou de vérité.

| Risque | Mesure |
|---|---|
| Artefact altéré | Signature Ed25519 sur l'empreinte de l'encodage canonique ; clés de confiance embarquées dans l'application, jamais téléchargées |
| Downgrade d'artefact | Le runtime refuse une version inférieure à la plus haute déjà activée ; version minimale imposable par le manifeste serveur |
| Rejeu malveillant | Registre `(sujet, operation_id)` côté Gateway, clé d'idempotence côté backend, opérations liées au sujet de la session |
| Élévation de privilège | Le serveur réévalue authentification, autorisations et règles métier à chaque rejeu ; hors ligne, une politique non décidable est refusée |
| Fuite inter-sessions | Projections restreintes au périmètre de la session, prouvé à la compilation ; purge automatique au changement de propriétaire ; base IndexedDB nommable par déploiement |
| Lecture hors périmètre | Un endpoint dont le résultat serveur peut inclure des lignes hors périmètre reste en ligne |
| Gateway comme proxy | Méthode et chemin vérifiés contre la route déclarée |
| Snapshot empoisonné | TLS, Gateway authentifiée, validation de la version de projection |
| Effets irréversibles | Toute dépendance vers un client HTTP, un broker, du mail… rend l'endpoint `ONLINE_REQUIRED` |
| Demi-écriture | Mutation locale et entrée d'outbox dans la même transaction |

À noter :

- Le chiffrement local n'est pas activé par défaut : un XSS actif dans l'origine
  aurait accès aux clés comme aux données (§14.3). La première défense reste la
  minimisation des projections, une CSP stricte et la purge au logout.
- Les messages d'erreur locaux sont produits par l'IR ; les corps d'erreur des
  `@RestControllerAdvice` sont reproduits quand ils sont calculables.
- `trusted-headers` n'est sûr que derrière un proxy qui écrase ces en-têtes.
