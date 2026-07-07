import { MadaraSource } from '../../src/sources/engines/madara'
import meta from './plugin.json'

// Config dérivée de l'extension Keiyoushi correspondante (thème Madara).
export default class Novel24hSource extends MadaraSource {
  constructor() {
    super({
      id: meta.id,
      name: meta.name,
      baseUrl: meta.baseUrl,
      lang: meta.lang,
      isNsfw: meta.nsfw,
      version: meta.version,
      useNewChapterEndpoint: true,
    })
  }
}
