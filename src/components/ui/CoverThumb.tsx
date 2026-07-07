import { useRemoteImage, type RemoteImageOptions } from '../../lib/remoteImage'

interface CoverThumbProps extends RemoteImageOptions {
  url: string | null | undefined
  alt: string
  /** Classes du conteneur (dimensions/arrondi) — défaut vignette de liste. */
  className?: string
  /** Classes additionnelles de l'<img> (ex. effet hover). */
  imgClassName?: string
}

/**
 * Vignette d'image distante (couverture) : squelette animé pendant le
 * chargement, image via le cache partagé (cf. lib/remoteImage) ensuite.
 * Remplace les composants Cover/CoverThumb locaux dupliqués des pages.
 */
export default function CoverThumb({
  url,
  alt,
  sourceId,
  headers,
  className = 'h-16 w-12 rounded',
  imgClassName = '',
}: CoverThumbProps) {
  const src = useRemoteImage(url, { sourceId, headers })
  return (
    <div className={`${className} shrink-0 overflow-hidden bg-surface-raised`}>
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={`h-full w-full object-cover ${imgClassName}`}
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-fill/10" />
      )}
    </div>
  )
}
