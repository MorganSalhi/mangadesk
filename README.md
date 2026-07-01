# MangaDesk

Lecteur de manga **desktop** (Windows) : bibliothèque, téléchargements hors-ligne,
suivi de lecture, plusieurs sources, mode webtoon/paginé. Construit avec
**Tauri 2** (Rust) + **React** + **Vite** + **Tailwind**.

## Installation

Téléchargez le dernier installateur depuis la page
[**Releases**](../../releases/latest) → `MangaDesk_x64-setup.exe`, puis exécutez-le.

> ⚠️ L'installateur n'est pas signé par un certificat éditeur payant : Windows
> SmartScreen peut afficher « Éditeur inconnu ». Cliquez sur *Informations
> complémentaires* → *Exécuter quand même*.

### Mises à jour

L'application vérifie les mises à jour au démarrage et propose de les installer
automatiquement (paquets signés, vérifiés par clé publique).

## Développement

Prérequis : [Node.js](https://nodejs.org) 20+, [pnpm](https://pnpm.io),
[Rust](https://rustup.rs) + les [prérequis Tauri](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev      # lance l'app en développement
pnpm tauri build    # génère l'installateur (dossier src-tauri/target/release/bundle)
```

## Publier une version

1. Bumper la version dans `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. La CI ([`.github/workflows/release.yml`](.github/workflows/release.yml)) build,
   signe, crée la Release et le `latest.json` consommé par l'updater.

## Avertissement

Ce logiciel est un **client de lecture** fourni à titre éducatif. Il n'héberge
aucun contenu : les sources pointent vers des sites tiers dont l'utilisateur est
seul responsable de l'usage, dans le respect des lois applicables et des droits
d'auteur.

## Licence

[MIT](LICENSE) © 2026 MangaDesk contributors
