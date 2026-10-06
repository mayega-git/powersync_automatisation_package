# Limites et extensions

Ce qu'AERIS ne promet pas (architecture §1, §21.2), et ce qui reste ouvert.

## Par construction

- Un backend arbitraire n'est pas rendu entièrement local : seuls les endpoints dont
  la sémantique est prouvée le sont ; le reste reste en ligne avec une raison.
- Paiement, effets tiers, autorisation fraîche, invariant global strict : en ligne.
- Une lecture locale reflète le dernier état synchronisé (fraîcheur bornée par endpoint).
- Pas de LLM dans le navigateur ni dans la décision de sécurité.

## Non modélisé aujourd'hui (endpoints `UNSUPPORTED`)

Les raisons exactes et leur fréquence sont dans `aeris-report.html`. Principales :

- État en mémoire dans les services (`Map` mutables) — inévitable.
- `Mono.zip` à plus de 8 sources, `Flux.flatMap` qui **écrit** par élément, `subscribe()`.
- `Flux.onErrorX` (Reactor émet les éléments déjà produits avant le repli : non
  reproductible sur une liste matérialisée), `onErrorResume` qui inspecte l'exception.
- Boucles `while`, `break/continue`, `try/finally`, `Map.merge` sur clés dynamiques.
- `DatabaseClient` / SQL brut, `@Modifying`, requêtes dérivées `Like/Containing/IgnoreCase`
  (dépendent de la collation de la base).
- Auditing Spring Data (`@CreatedDate`, `@LastModifiedDate`) : détecté et refusé,
  jamais approximé. Convertisseurs R2DBC personnalisés.
- Pagination (`Pageable`, `Sort` dynamiques).
- `WebFilter` globaux : non analysés, à déclarer en `requestGates` s'ils peuvent rejeter.

## Extensions prévues par l'architecture

- **Autres frameworks** : l'IR et le runtime sont indépendants du langage ; un adaptateur
  NestJS/Prisma ou Laravel produit les mêmes `EndpointDraft`.
- **Modèle léger au build** (§13) : proposer des annotations pour les cas
  `UNSUPPORTED` récurrents ; ses propositions restent vérifiées par le compilateur et
  les tests différentiels, jamais exécutées telles quelles.
- **Écritures par élément** (`saveAll`, `flatMap(repo::save)`) : étendre `EACH` aux
  écritures demande des identifiants capturés par élément et un `idMap` indexé.
- **Lecture d'un enfant par sa propre clé** : désormais prouvée (voir `compilateur.md`),
  mais seulement quand la garde est une assertion et que l'absence de l'enfant et le
  parent hors périmètre lèvent la **même** erreur. Un backend qui nomme lequel des deux a
  échoué reste en ligne — à juste titre : son corps de réponse divergerait, et il révèle
  à l'appelant qu'une ligne qu'il n'a pas le droit de voir existe.
