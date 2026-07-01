interface PagePlaceholderProps {
  title: string
}

/** Placeholder partagé par toutes les pages stub de la session 1. */
export default function PagePlaceholder({ title }: PagePlaceholderProps) {
  return (
    <section className="flex h-full flex-col items-start gap-3 p-10">
      <h1 className="text-3xl font-semibold tracking-tight text-content">
        {title}
      </h1>
      <p className="text-sm text-content-3">En cours d'implémentation.</p>
    </section>
  )
}
