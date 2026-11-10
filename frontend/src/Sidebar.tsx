import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useState, type RefObject } from 'react'
import { listNotes } from './api.ts'
import { groupByDate, rowDate } from './format.ts'

const PAGE_SIZE = 30

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

type Props = {
  selectedId: number | null
  onNewNote: () => void
  searchRef: RefObject<HTMLInputElement | null>
}

export default function Sidebar({ selectedId, onNewNote, searchRef }: Props) {
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim(), 250)

  const notes = useInfiniteQuery({
    queryKey: ['notes', q],
    queryFn: ({ pageParam }) => listNotes({ q, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.notes.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    // Keep showing the old results while a new search loads, instead of flashing empty
    placeholderData: keepPreviousData,
  })

  const items = notes.data?.pages.flatMap((p) => p.notes) ?? []
  const groups = groupByDate(items)

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="wordmark">ai-notes</span>
          <button className="pill primary" onClick={onNewNote}>
            New note
          </button>
        </div>
        <input
          ref={searchRef}
          type="search"
          className="search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {notes.isError && (
        <div className="sidebar-message error" role="alert">
          <p>Couldn't load your notes. {notes.error.message}</p>
          <button className="pill" onClick={() => notes.refetch()}>
            Try again
          </button>
        </div>
      )}

      {notes.isSuccess && items.length === 0 && (
        <p className="sidebar-message">
          {q ? `No notes match “${q}”.` : 'Nothing here yet. Notes you write show up in this list.'}
        </p>
      )}

      <nav aria-label="Notes" aria-busy={notes.isPlaceholderData}>
        {groups.map((group) => (
          <section key={group.label} className="note-group" aria-label={group.label}>
            <h2 className="group-label">{group.label}</h2>
            <ul className="note-list">
              {group.items.map((note) => (
                <li key={note.id}>
                  <a
                    href={`#/notes/${note.id}`}
                    className="note-row"
                    aria-current={note.id === selectedId ? 'page' : undefined}
                  >
                    <span className="row-title">{note.title}</span>
                    <span className="row-date">{rowDate(note.created_at)}</span>
                    <span className="row-snippet">{note.body}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>

      {notes.hasNextPage && (
        <button
          className="pill load-more"
          onClick={() => notes.fetchNextPage()}
          disabled={notes.isFetchingNextPage}
        >
          {notes.isFetchingNextPage ? 'Loading…' : 'Show older notes'}
        </button>
      )}
    </aside>
  )
}
