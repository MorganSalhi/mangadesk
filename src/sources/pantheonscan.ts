import { MadaraSource } from './engines/madara'

// Pantheon Scan — Madara (themePkg=madara, useNewChapterEndpoint=true).
// Cf. Keiyoushi src/fr/pantheonscan. Base /manga/ par défaut.
export class PantheonScanSource extends MadaraSource {
  constructor() {
    super({
      id: 'pantheonscan',
      name: 'Pantheon Scan',
      baseUrl: 'https://pantheon-scan.com',
      lang: 'fr',
      isNsfw: true,
      useNewChapterEndpoint: true,
    })
  }
}
