# Second corpus de validation

Le compilateur a été développé contre **un seul** backend réel. Valider contre un seul
projet ne peut pas révéler ce qu'on y a inconsciemment ajusté : l'architecture peut être
propre, le code sans aucun nom du backend d'origine, et une heuristique rester calée sur
son vocabulaire. C'est arrivé.

`taskly/` est là pour ça : une application de listes de tâches, écrite comme une vraie
application, puis passée au compilateur **sans être retouchée pour lui plaire**. Si elle
échoue, c'est le compilateur qu'on corrige, pas le backend.

Elle diffère volontairement sur chaque axe qu'on contrôle :

| | backend d'origine | `taskly` |
|---|---|---|
| Vocabulaire de session | `tenantId`, `organizationId` | `workspaceId`, `memberId` |
| Découpage | hexagonal (`port/out`, `adapter/out`) | par fonctionnalité |
| Modules | multi-module Maven | module unique |
| Entités | classes Lombok et records | les deux, répartis autrement |
| Erreurs | `ResponseStatusException` + advice | exceptions métier + advice |
| Réponses | enveloppe `ApiResponse` | DTO nus |
| Idempotence | filtre `Idempotency-Key` | aucun |

## Ce qu'il a trouvé

Au premier passage, trois défauts de généricité, tous dans la détection de configuration :

1. Les profils Spring n'étaient lus que pour un projet **multi-module** : le chemin
   cherché supposait `.../src/main/`, donc un module unique ne trouvait jamais son
   `application.yml`.
2. `scopeClaims` était rempli avec `tenantId`/`organizationId` **en dur**, au lieu d'être
   dérivé des identifiants du record de session détecté.
3. Les candidats `inertEffects` n'étaient cherchés que par le **nom de la classe** :
   `ActivityLog.record` passait à travers, là où `AuditService.save` était trouvé.

Il a aussi confirmé que le plus gros blocage restant n'est pas un cas particulier :
charger un enfant par sa clé puis vérifier son parent (`TaskService.byId` ici,
`ProductVariantEntity` là-bas) est un idiome courant, rencontré sur deux backends
indépendants.

## Lancer le compilateur dessus

```bash
npx tsx .scratch/detect.mts test-backends/taskly   # ce que `aeris init` proposerait
```

Après relecture de la proposition — déclarer `ActivityLog.record` inerte et `Label`
publique — les 15 endpoints se classent sans aucun `UNSUPPORTED` : tout ce qui reste en
ligne l'est pour une raison sémantique (pas d'idempotence, appel externe, périmètre).
