import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ApiError,
  BODY_MAX,
  createNote,
  deleteNote,
  getNote,
  summariseErrorMessage,
  summariseNote,
  TITLE_MAX,
  updateNote,
  type Note,
} from './api.ts'
import { wordCount } from './format.ts'

// How long typing has to pause before the note saves itself
export const AUTOSAVE_MS = 600

type SaveState =
  | { kind: 'clean' }
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

type Props = {
  noteId: number | null
  onCreated: (id: number) => void
  onGone: () => void
  focusMode: boolean
  onToggleFocus: () => void
}

// Loads the note (or starts a blank page), then hands over to the editor itself
export default function Editor(props: Props) {
  // The id this editor was opened with. A draft that gets saved keeps its editor.
  const [openedWith] = useState(props.noteId)
  const note = useQuery({
    queryKey: ['note', openedWith],
    queryFn: () => getNote(openedWith!),
    enabled: openedWith !== null,
  })

  if (openedWith !== null && note.isError) {
    const missing = note.error instanceof ApiError && note.error.status === 404
    return (
      <div className="page page-message">
        <p className="lede">{missing ? 'This note no longer exists.' : "Couldn't open this note."}</p>
        <p className="hint">{missing ? 'It may have been deleted.' : note.error.message}</p>
        <a className="pill" href="#/">
          Start a new note
        </a>
      </div>
    )
  }
  if (openedWith !== null && !note.data) {
    return <div className="page" aria-busy="true" />
  }
  return <EditorBody {...props} initial={note.data ?? null} />
}

function EditorBody({
  initial,
  onCreated,
  onGone,
  focusMode,
  onToggleFocus,
}: Props & { initial: Note | null }) {
  const qc = useQueryClient()
  const [id, setId] = useState<number | null>(initial?.id ?? null)
  const idRef = useRef(id)
  const live = useQuery({
    queryKey: ['note', id],
    queryFn: () => getNote(id!),
    enabled: id !== null,
  })

  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [save, setSave] = useState<SaveState>({ kind: 'clean' })
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const latest = useRef({ title, body })
  const saved = useRef({ title, body })
  const queue = useRef<Promise<void>>(Promise.resolve())
  const gone = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // Saves whatever is on the page now. Saves run one at a time, in order.
  const flush = useCallback((): Promise<void> => {
    queue.current = queue.current.then(async () => {
      const { title, body } = latest.current
      if (gone.current) return
      if (title === saved.current.title && body === saved.current.body) return
      if (!body.trim()) {
        setSave({ kind: 'empty' })
        return
      }
      setSave({ kind: 'saving' })
      const input = { title: title.trim() || 'Untitled', body }
      try {
        const note =
          idRef.current === null
            ? await createNote(input)
            : await updateNote(idRef.current, input)
        saved.current = { title, body }
        qc.setQueryData(['note', note.id], note)
        qc.invalidateQueries({ queryKey: ['notes'] })
        if (idRef.current === null) {
          idRef.current = note.id
          setId(note.id)
          onCreated(note.id)
        }
        const changedSince =
          latest.current.title !== title || latest.current.body !== body
        setSave({ kind: changedSince ? 'editing' : 'saved' })
      } catch (e) {
        setSave({ kind: 'error', message: e instanceof Error ? e.message : 'Unknown error' })
      }
    })
    return queue.current
  }, [qc, onCreated])

  // Save a moment after typing stops
  useEffect(() => {
    latest.current = { title, body }
    if (title === saved.current.title && body === saved.current.body) return
    const t = setTimeout(() => void flush(), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [title, body, flush])

  // Leaving the note (or the page) saves anything still pending
  useEffect(() => {
    const beforeUnload = () => void flush()
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      void flush()
    }
  }, [flush])

  // ⌘S / Ctrl+S saves straight away instead of opening the browser's save dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flush()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush])

  // Grow the writing area with its text, so the page scrolls rather than a box
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [body])

  const summarise = useMutation({
    mutationFn: async () => {
      await flush()
      const pending =
        latest.current.title !== saved.current.title || latest.current.body !== saved.current.body
      if (idRef.current === null || pending) {
        throw new ApiError(0, 'Save the note before summarising it.')
      }
      return summariseNote(idRef.current)
    },
    onSuccess: (note) => {
      qc.setQueryData(['note', note.id], note)
      qc.invalidateQueries({ queryKey: ['notes'] })
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteNote(idRef.current!),
    onMutate: () => {
      gone.current = true
    },
    onError: () => {
      gone.current = false
    },
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['note', idRef.current] })
      qc.invalidateQueries({ queryKey: ['notes'] })
      onGone()
    },
  })

  function edit(next: { title?: string; body?: string }) {
    if (next.title !== undefined) setTitle(next.title)
    if (next.body !== undefined) setBody(next.body)
    setSave({ kind: 'editing' })
  }

  const note = live.data
  const words = wordCount(body)
  const justSummarised = summarise.isSuccess && summarise.data.summary === note?.summary

  return (
    <div className="page">
      <div className="editor-bar">
        <a className="back" href="#/">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Notes
        </a>
        <SaveStatus state={save} onRetry={() => void flush()} />
        <div className="bar-actions">
          <button
            className="ghost"
            onClick={onToggleFocus}
            aria-pressed={focusMode}
            title="Focus mode (⌘. or Ctrl+.)"
          >
            {focusMode ? 'Leave focus' : 'Focus'}
          </button>
          {id !== null &&
            (confirmingDelete ? (
              <span className="confirm">
                Delete this note?
                <button className="ghost" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
                <button
                  className="ghost danger"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </span>
            ) : (
              <button className="ghost" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            ))}
        </div>
      </div>
      {remove.isError && (
        <p className="error" role="alert">
          Couldn't delete this note. {remove.error.message}
        </p>
      )}

      <article className="sheet">
        <input
          className="title-input"
          aria-label="Title"
          placeholder="Untitled"
          value={title}
          maxLength={TITLE_MAX}
          autoFocus={initial === null}
          onChange={(e) => edit({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              bodyRef.current?.focus()
            }
          }}
        />
        <textarea
          ref={bodyRef}
          className="body-input"
          aria-label="Note"
          placeholder="Start writing…"
          rows={3}
          value={body}
          maxLength={BODY_MAX}
          onChange={(e) => edit({ body: e.target.value })}
        />
        {words > 0 && (
          <p className="word-count">
            {words} {words === 1 ? 'word' : 'words'}
          </p>
        )}

        {id !== null && (
          <section className="summary" aria-label="Summary">
            <div className="summary-head">
              <h2>Summary</h2>
              <button
                className="pill primary"
                onClick={() => summarise.mutate()}
                disabled={summarise.isPending || !body.trim()}
              >
                {note?.summary ? 'Summarise again' : 'Summarise'}
              </button>
            </div>

            {summarise.isPending ? (
              <p className="summary-text" aria-live="polite">
                <span className="highlight thinking">Reading your note…</span>
              </p>
            ) : note?.summary ? (
              <>
                <p className={`summary-text${note.summary_stale ? ' stale' : ''}`}>
                  <mark
                    key={note.summarised_at}
                    className={`highlight${justSummarised ? ' arrive' : ''}`}
                  >
                    {note.summary}
                  </mark>
                </p>
                {note.summary_stale && (
                  <p className="hint">This summary is out of date. Summarise again to refresh it.</p>
                )}
              </>
            ) : (
              <p className="hint">Get a one-sentence summary from the model on your computer.</p>
            )}

            {summarise.isError && (
              <p className="error" role="alert">
                {summariseErrorMessage(summarise.error)}
              </p>
            )}
          </section>
        )}
      </article>
    </div>
  )
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.kind === 'error') {
    return (
      <span className="save-status error" role="alert">
        Not saved: {state.message}
        <button className="ghost" onClick={onRetry}>
          Try again
        </button>
      </span>
    )
  }
  const text = {
    clean: '',
    editing: 'Editing',
    saving: 'Saving…',
    saved: 'Saved',
    empty: 'Write something to save this note',
  }[state.kind]
  return (
    <span className={`save-status ${state.kind}`} aria-live="polite">
      {text}
    </span>
  )
}
