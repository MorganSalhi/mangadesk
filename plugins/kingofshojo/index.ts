import { MangaThemesiaSource } from '../../src/sources/engines/mangathemesia'
import meta from './plugin.json'

// Config dérivée de l'extension Keiyoushi correspondante (thème MangaThemesia).
export default class KingofshojoSource extends MangaThemesiaSource {
  constructor() {
    super({
      id: meta.id,
      name: meta.name,
      baseUrl: meta.baseUrl,
      lang: meta.lang,
      isNsfw: meta.nsfw,
      version: meta.version,
    })
  }
}
