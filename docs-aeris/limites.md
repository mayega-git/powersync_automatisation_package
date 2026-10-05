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
- `Mono.zip` à plus de 8 sources, `Flux.flatMap` avec effet par élément, `subscribe()`.
- Boucles `for` classiques, `while`, `break/continue`, `try/finally`.
- `DatabaseClient` / SQL brut, `@Modifying`, requêtes dérivées `Like/Containing/IgnoreCase`
  (dépendent de la collation de la base).
- Verrouillage optimiste `@Version`, auditing Spring Data, convertisseurs R2DBC.
- Pagination (`Pageable`, `Sort` dynamiques).
- `WebFilter` globaux : non analysés, à déclarer en `requestGates` s'ils peuvent rejeter.

## Extensions prévues par l'architecture

- **Autres frameworks** : l'IR et le runtime sont indépendants du langage ; un adaptateur
  NestJS/Prisma ou Laravel produit les mêmes `EndpointDraft`.
- **Modèle léger au build** (§13) : proposer des annotations pour les cas
  `UNSUPPORTED` récurrents ; ses propositions restent vérifiées par le compilateur et
  les tests différentiels, jamais exécutées telles quelles.
- **Compilation des beans de politique** : traduire `BusinessAccessPolicy` en
  expressions IR au lieu de les réimplémenter côté front.
