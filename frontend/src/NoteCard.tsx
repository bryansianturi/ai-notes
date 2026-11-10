import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import {
  BODY_MAX,
  deleteNote,
  summariseErrorMessage,
  summariseNote,
  TITLE_MAX,
  updateNote,
  type Note,
} from './api.ts'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function NoteCard({ note }: { note: Note }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notes'] })

  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)

  const save = useMutation({
    mutationFn: () => updateNote(note.id, { title: title.trim(), body }),
    onSuccess: () => {
      setEditing(false)
      refresh()
    },
  })
  const remove = useMutation({ mutationFn: () => deleteNote(note.id), onSuccess: refresh })
  const summarise = useMutation({ mutationFn: () => summariseNote(note.id), onSuccess: refresh })

  function startEditing() {
    setTitle(note.title)
    setBody(note.body)
    save.reset()
    setEditing(true)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    save.mutate()
  }

  if (editing) {
    return (
      <form className="card note" onSubmit={submit} aria-label={`Edit ${note.title}`}>
        <input
          aria-label="Title"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          aria-label="Body"
          rows={6}
          value={body}
          maxLength={BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
        />
        {save.isError && (
          <p className="error" role="alert">
            {save.error.message}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={save.isPending || !title.trim() || !body.trim()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    )
  }

  return (
    <article className="card note" aria-label={note.title}>
      <div className="note-head">
        <h2>{note.title}</h2>
        <time className="muted" dateTime={note.created_at}>
          {dateFormat.format(new Date(note.created_at))}
        </time>
      </div>
      <p className="body">{note.body}</p>

      {summarise.isPending ? (
        <div className="summary pending" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Summarising…
        </div>
      ) : (
        note.summary && (
          <div className={`summary${note.summary_stale ? ' stale' : ''}`}>
            <span className="label">
              Summary{note.summary_stale && <span className="badge">out of date</span>}
            </span>
            <p>{note.summary}</p>
          </div>
        )
      )}
      {summarise.isError && (
        <p className="error" role="alert">
          {summariseErrorMessage(summarise.error)}
        </p>
      )}
      {remove.isError && (
        <p className="error" role="alert">
          Couldn't delete: {remove.error.message}
        </p>
      )}

      <div className="actions">
        {confirmingDelete ? (
          <>
            <span className="muted">Delete this note?</span>
            <button onClick={() => setConfirmingDelete(false)}>Cancel</button>
            <button
              className="danger"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : 'Yes, delete'}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setConfirmingDelete(true)}>Delete</button>
            <button onClick={startEditing}>Edit</button>
            <button
              className="primary"
              onClick={() => summarise.mutate()}
              disabled={summarise.isPending}
            >
              {note.summary ? 'Re-summarise' : 'Summarise'}
            </button>
          </>
        )}
      </div>
    </article>
  )
}
