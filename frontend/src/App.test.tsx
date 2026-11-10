import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import type { Note } from './api.ts'

// A tiny in-memory stand-in for the FastAPI back-end, wired in through fetch
let notes: Note[]
let nextId: number
let summariseStatus: number

function makeNote(title: string, body: string): Note {
  const now = new Date().toISOString()
  return {
    id: nextId++,
    title,
    body,
    created_at: now,
    updated_at: now,
    summary: null,
    summary_model: null,
    summary_prompt_version: null,
    summarised_at: null,
    summary_stale: false,
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://test')
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(init.body as string) : undefined
  const match = url.pathname.match(/^\/api\/notes(?:\/(\d+))?(\/summarise)?$/)
  if (!match) return json({ detail: 'Not Found' }, 404)
  const id = match[1] ? Number(match[1]) : undefined
  const note = notes.find((n) => n.id === id)

  if (method === 'GET' && id === undefined) {
    const q = url.searchParams.get('q')?.toLowerCase() ?? ''
    const hits = notes
      .filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q))
      .reverse()
    const offset = Number(url.searchParams.get('offset'))
    const limit = Number(url.searchParams.get('limit'))
    return json(hits.slice(offset, offset + limit), 200, { 'X-Total-Count': String(hits.length) })
  }
  if (method === 'POST' && id === undefined) {
    const created = makeNote(body.title, body.body)
    notes.push(created)
    return json(created, 201)
  }
  if (!note) return json({ detail: 'Note not found' }, 404)
  if (match[2]) {
    if (summariseStatus !== 200) {
      const detail =
        summariseStatus === 503 ? "Can't reach Ollama. Is it running?" : 'Ollama returned an error (404)'
      return json({ detail }, summariseStatus)
    }
    Object.assign(note, { summary: `Summary of ${note.title}.`, summary_stale: false })
    return json(note)
  }
  if (method === 'PATCH') {
    if (body.body !== undefined && body.body !== note.body && note.summary) note.summary_stale = true
    Object.assign(note, body)
    return json(note)
  }
  if (method === 'DELETE') {
    notes = notes.filter((n) => n.id !== id)
    return json(null, 204)
  }
  return json({ detail: 'Method Not Allowed' }, 405)
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  nextId = 1
  notes = []
  summariseStatus = 200
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ai-notes', () => {
  it('shows an empty state, then a newly created note', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument()

    const form = screen.getByRole('form', { name: 'New note' })
    await user.type(within(form).getByLabelText('Title'), 'Groceries')
    await user.type(within(form).getByLabelText('Body'), 'Milk, eggs')
    await user.click(within(form).getByRole('button', { name: 'Add note' }))

    expect(await screen.findByRole('article', { name: 'Groceries' })).toBeInTheDocument()
    expect(screen.getByText('1 note')).toBeInTheDocument()
    expect(within(form).getByLabelText('Title')).toHaveValue('')
  })

  it('lists newest first and filters by search', async () => {
    notes = [makeNote('Older', 'about cats'), makeNote('Newer', 'about dogs')]
    const user = userEvent.setup()
    renderApp()

    const articles = await screen.findAllByRole('article')
    expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual(['Newer', 'Older'])

    await user.type(screen.getByLabelText('Search notes'), 'cats')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Newer' })).toBeNull())
    expect(screen.getByRole('article', { name: 'Older' })).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Search notes'))
    await user.type(screen.getByLabelText('Search notes'), 'zebras')
    expect(await screen.findByText(/No notes match/)).toBeInTheDocument()
  })

  it('edits a note and marks its summary out of date', async () => {
    notes = [makeNote('Trip', 'Flights on Friday')]
    const user = userEvent.setup()
    renderApp()

    const card = await screen.findByRole('article', { name: 'Trip' })
    await user.click(within(card).getByRole('button', { name: 'Summarise' }))
    expect(await screen.findByText('Summary of Trip.')).toBeInTheDocument()
    expect(screen.queryByText('out of date')).toBeNull()

    await user.click(within(screen.getByRole('article', { name: 'Trip' })).getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit Trip' })
    await user.clear(within(form).getByLabelText('Body'))
    await user.type(within(form).getByLabelText('Body'), 'Flights on Saturday')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Flights on Saturday')).toBeInTheDocument()
    expect(screen.getByText('out of date')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-summarise' })).toBeInTheDocument()
  })

  it('asks for confirmation before deleting', async () => {
    notes = [makeNote('Temp', 'Delete me')]
    const user = userEvent.setup()
    renderApp()

    const card = await screen.findByRole('article', { name: 'Temp' })
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await user.click(within(card).getByRole('button', { name: 'Cancel' }))
    expect(notes).toHaveLength(1)

    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await user.click(within(card).getByRole('button', { name: 'Yes, delete' }))
    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument()
    expect(notes).toHaveLength(0)
  })

  it.each([
    [503, "Can't reach Ollama. Is it running?"],
    [502, 'Ollama returned an error (404). Check that the model is pulled in Ollama.'],
  ])('explains a %i from summarise', async (status, message) => {
    notes = [makeNote('Note', 'Body')]
    summariseStatus = status
    const user = userEvent.setup()
    renderApp()

    const card = await screen.findByRole('article', { name: 'Note' })
    await user.click(within(card).getByRole('button', { name: 'Summarise' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent(message)
  })

  it('shows a retryable error when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server")
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
