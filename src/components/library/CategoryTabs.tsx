import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Category } from '../../types'

interface CategoryTabsProps {
  categories: Category[]
  activeCategory: number | null
  onSelect(id: number | null): void
  onReorder(ids: number[]): void
  onAddClick(): void
}

function tabClass(active: boolean): string {
  return [
    'whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
    active
      ? 'bg-accent text-white'
      : 'bg-fill/5 text-content-2 hover:bg-fill/10',
  ].join(' ')
}

function SortableTab({
  category,
  active,
  onSelect,
}: {
  category: Category
  active: boolean
  onSelect(): void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: category.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      className={tabClass(active)}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {category.name}
    </button>
  )
}

/** Onglets de catégories : "Tous" fixe + catégories réordonnables (drag & drop). */
export default function CategoryTabs({
  categories,
  activeCategory,
  onSelect,
  onReorder,
  onAddClick,
}: CategoryTabsProps) {
  // distance:8 → un simple clic n'est pas interprété comme un drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = categories.findIndex((c) => c.id === active.id)
    const newIndex = categories.findIndex((c) => c.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(categories, oldIndex, newIndex)
    onReorder(reordered.map((c) => c.id))
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-line/5 px-4 py-3">
      <button
        type="button"
        className={tabClass(activeCategory === null)}
        onClick={() => onSelect(null)}
      >
        Tous
      </button>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={categories.map((c) => c.id)}
          strategy={horizontalListSortingStrategy}
        >
          {categories.map((category) => (
            <SortableTab
              key={category.id}
              category={category}
              active={activeCategory === category.id}
              onSelect={() => onSelect(category.id)}
            />
          ))}
        </SortableContext>
      </DndContext>

      <button
        type="button"
        className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill/5 text-lg text-content-2 hover:bg-fill/10"
        onClick={onAddClick}
        aria-label="Créer une catégorie"
      >
        +
      </button>
    </div>
  )
}
