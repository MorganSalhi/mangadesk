import type {
  Chapter,
  Filter,
  Manga,
  MangaListPage,
  MangaPreview,
  Page,
  Source,
} from '../types'

// ============================================================================
// Source de démonstration — 100 % mockée, zéro appel réseau.
// Importée statiquement et enregistrée dans SOURCE_REGISTRY depuis main.tsx.
// ============================================================================

const STATUSES: Manga['status'][] = [
  'ongoing',
  'completed',
  'hiatus',
  'cancelled',
  'unknown',
]

const GENRE_POOL = [
  'Action',
  'Aventure',
  'Comédie',
  'Drame',
  'Fantasy',
  'Horreur',
  'Romance',
  'Science-fiction',
  'Tranche de vie',
  'Mystère',
]

const TITLES = [
  'Lames de Cendre',
  'Le Jardin Suspendu',
  'Capitaine Orage',
  'Mémoires de Néon',
  'La Forge Étoilée',
  'Chroniques du Vent Pâle',
  'Renard de Minuit',
  'Aciers & Pivoines',
  'Le Dernier Phare',
  'Ombres de Verre',
  'Frontière Écarlate',
  'Le Chant des Marées',
  'Engrenages du Ciel',
  'Pluie de Lanternes',
  'Le Serment du Héron',
  'Cités de Poussière',
  'Lune de Fer',
  'Les Sentiers Pourpres',
  'Écho du Glacier',
  'Le Bestiaire Oublié',
]

function buildManga(index: number): Manga {
  const id = `demo-manga-${index + 1}`
  const genres = [
    GENRE_POOL[index % GENRE_POOL.length],
    GENRE_POOL[(index + 3) % GENRE_POOL.length],
  ]
  return {
    id,
    sourceId: 'demo',
    title: TITLES[index] ?? `Manga démo ${index + 1}`,
    coverUrl: `https://picsum.photos/seed/${id}/300/400`,
    description:
      'Un récit de démonstration entièrement fictif, généré localement pour ' +
      'tester la bibliothèque, la navigation et le lecteur sans aucun appel réseau.',
    author: `Auteur ${String.fromCharCode(65 + (index % 26))}`,
    artist: `Dessinateur ${String.fromCharCode(65 + ((index + 5) % 26))}`,
    status: STATUSES[index % STATUSES.length],
    genres,
    inLibrary: false,
  }
}

const MANGAS: Manga[] = Array.from({ length: 20 }, (_, i) => buildManga(i))

function toPreview(m: Manga): MangaPreview {
  return { id: m.id, title: m.title, coverUrl: m.coverUrl, sourceId: m.sourceId }
}

const PAGE_SIZE = 20

export class DemoSource implements Source {
  readonly id = 'demo'
  readonly name = 'Source démo'
  readonly lang = 'fr'
  readonly baseUrl = 'https://example.invalid'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  readonly filters: Filter[] = [
    {
      id: 'sort',
      name: 'Tri',
      type: 'sort',
      value: 'title',
      options: ['title', 'latest'],
    },
  ]

  async search(
    query: string,
    page: number,
    _filters: Filter[],
  ): Promise<MangaListPage> {
    const q = query.trim().toLowerCase()
    const matched = q
      ? MANGAS.filter((m) => m.title.toLowerCase().includes(q))
      : MANGAS
    return this.paginate(matched.map(toPreview), page)
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const manga = MANGAS.find((m) => m.id === mangaId)
    if (!manga) throw new Error(`Manga inconnu : ${mangaId}`)
    return { ...manga }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const manga = MANGAS.find((m) => m.id === mangaId)
    if (!manga) throw new Error(`Manga inconnu : ${mangaId}`)
    // 5 chapitres numérotés 1.0 → 5.0, du plus récent au plus ancien.
    return Array.from({ length: 5 }, (_, i) => {
      const number = 5 - i
      return {
        id: `${mangaId}-ch-${number}`,
        mangaId,
        number,
        title: `Chapitre ${number}`,
        scanlator: 'Team Démo',
        dateUpload: Date.now() - i * 86_400_000,
        isRead: false,
        lastPageRead: 0,
      }
    })
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    // 10 pages par chapitre.
    return Array.from({ length: 10 }, (_, i) => ({
      index: i,
      imageUrl: `https://picsum.photos/seed/${chapterId}-${i}/800/1200`,
    }))
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const sorted = [...MANGAS].sort((a, b) => (a.id < b.id ? 1 : -1))
    return this.paginate(sorted.map(toPreview), page)
  }

  private paginate(items: MangaPreview[], page: number): MangaListPage {
    const start = (page - 1) * PAGE_SIZE
    const slice = items.slice(start, start + PAGE_SIZE)
    return {
      mangas: slice,
      hasNextPage: start + PAGE_SIZE < items.length,
      currentPage: page,
    }
  }
}
