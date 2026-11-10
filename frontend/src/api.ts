// Typed wrapper around the FastAPI back-end. Every call goes to /api/*, which
// the Vite dev server (or nginx in production) forwards to the API.

export type Note = {
  id: number
  title: string
  body: string
  created_at: string
  updated_at: string
  summary: string | null
  summary_model: string | null
  summary_prompt_version: string | null
  summarised_at: string | null
  summary_stale: boolean
}

export type NoteInput = { title: string; body: string }

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// FastAPI sends {"detail": "text"}, or a list of field errors for a 422
function describe(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : undefined
        return field ? `${field}: ${d.msg}` : String(d?.msg ?? '')
      })
      .join('; ')
  }
  return fallback
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, describe(body?.detail, `Request failed (${res.status})`))
  }
  return res
}

export async function listNotes(params: {
  q?: string
  limit: number
  offset: number
}): Promise<{ notes: Note[]; total: number }> {
  const search = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  })
  if (params.q) search.set('q', params.q)
  const res = await request(`/notes?${search}`)
  const notes: Note[] = await res.json()
  const total = Number(res.headers.get('X-Total-Count') ?? notes.length)
  return { notes, total }
}

export async function createNote(input: NoteInput): Promise<Note> {
  const res = await request('/notes', { method: 'POST', body: JSON.stringify(input) })
  return res.json()
}

export async function updateNote(id: number, input: Partial<NoteInput>): Promise<Note> {
  const res = await request(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
  return res.json()
}

export async function deleteNote(id: number): Promise<void> {
  await request(`/notes/${id}`, { method: 'DELETE' })
}

export async function summariseNote(id: number): Promise<Note> {
  const res = await request(`/notes/${id}/summarise`, { method: 'POST' })
  return res.json()
}

// Turn summarise failures into something a person can act on
export function summariseErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong while summarising.'
  switch (err.status) {
    case 503:
      return "Can't reach Ollama. Is it running?"
    case 502:
      return `${err.message}. Check that the model is pulled in Ollama.`
    case 409:
      return 'The note changed while it was being summarised. Try again.'
    default:
      return err.message
  }
}

// Mirrors the limits in main.py (NoteIn)
export const TITLE_MAX = 200
export const BODY_MAX = 20_000
