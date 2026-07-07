import { MadaraSource } from '../../src/sources/engines/madara'
import meta from './plugin.json'

// Config dérivée de l'extension Keiyoushi correspondante (thème Madara).
export default class OrchisasiaSource extends MadaraSource {
  constructor() {
    super({
      id: meta.id,
      name: meta.name,
      baseUrl: meta.baseUrl,
      lang: meta.lang,
      isNsfw: meta.nsfw,
      version: meta.version,
      archiveSub: "comic",
      useNewChapterEndpoint: false,
    })
  }
}
