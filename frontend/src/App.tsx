import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { BODY_MAX, createNote, listNotes, TITLE_MAX } from './api.ts'
import NoteCard from './NoteCard.tsx'

const PAGE_SIZE = 20

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

function NewNoteForm() {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const create = useMutation({
    mutationFn: createNote,
    onSuccess: () => {
      setTitle('')
      setBody('')
      queryClient.invalidateQueries({ queryKey: ['notes'] })
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return
    create.mutate({ title: title.trim(), body })
  }

  return (
    <form className="card new-note" onSubmit={submit} aria-label="New note">
      <input
        aria-label="Title"
        placeholder="Title"
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        aria-label="Body"
        placeholder="Write a note…"
        rows={4}
        value={body}
        maxLength={BODY_MAX}
        onChange={(e) => setBody(e.target.value)}
      />
      {create.isError && (
        <p className="error" role="alert">
          {create.error.message}
        </p>
      )}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={create.isPending || !title.trim() || !body.trim()}
        >
          {create.isPending ? 'Saving…' : 'Add note'}
        </button>
      </div>
    </form>
  )
}

export default function App() {
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim(), 300)

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
  const total = notes.data?.pages[0]?.total ?? 0

  return (
    <div className="page">
      <header>
        <h1>ai-notes</h1>
        <p className="muted">Notes, summarised by a local model.</p>
      </header>

      <NewNoteForm />

      <div className="toolbar">
        <input
          type="search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {notes.isSuccess && (
          <span className="muted count">
            {total} {total === 1 ? 'note' : 'notes'}
          </span>
        )}
      </div>

      {notes.isPending && <p className="muted">Loading notes…</p>}

      {notes.isError && (
        <div className="card error-banner" role="alert">
          <span>Couldn't load notes: {notes.error.message}</span>
          <button onClick={() => notes.refetch()}>Retry</button>
        </div>
      )}

      {notes.isSuccess && items.length === 0 && (
        <p className="muted empty">
          {q ? `No notes match “${q}”.` : 'No notes yet. Write your first one above.'}
        </p>
      )}

      <ul className="notes" aria-busy={notes.isPlaceholderData}>
        {items.map((note) => (
          <li key={note.id}>
            <NoteCard note={note} />
          </li>
        ))}
      </ul>

      {notes.hasNextPage && (
        <div className="load-more">
          <button onClick={() => notes.fetchNextPage()} disabled={notes.isFetchingNextPage}>
            {notes.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
