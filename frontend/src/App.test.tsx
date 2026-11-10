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
let calls: string[]

function makeNote(title: string, body: string, extra: Partial<Note> = {}): Note {
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
    ...extra,
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
  calls.push(`${method} ${url.pathname}`)
  const body = init.body ? JSON.parse(init.body as string) : undefined
  const match = url.pathname.match(/^\/api\/notes(?:\/(\d+))?(\/summarise)?$/)
  if (!match) return json({ detail: 'Not Found' }, 404)
  const id = match[1] ? Number(match[1]) : undefined
  const note = notes.find((n) => n.id === id)

  if (id === undefined) {
    if (method === 'POST') {
      const created = makeNote(body.title, body.body)
      notes.push(created)
      return json(created, 201)
    }
    const q = url.searchParams.get('q')?.toLowerCase() ?? ''
    const hits = notes
      .filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q))
      .reverse()
    const offset = Number(url.searchParams.get('offset'))
    const limit = Number(url.searchParams.get('limit'))
    return json(hits.slice(offset, offset + limit), 200, { 'X-Total-Count': String(hits.length) })
  }

  if (!note) return json({ detail: 'Note not found' }, 404)
  if (match[2]) {
    if (summariseStatus !== 200) {
      const detail =
        summariseStatus === 503
          ? "Can't reach Ollama. Is it running?"
          : 'Ollama returned an error (404)'
      return json({ detail }, summariseStatus)
    }
    Object.assign(note, {
      summary: `Summary of ${note.title}.`,
      summary_stale: false,
      summarised_at: new Date().toISOString(),
    })
    return json(note)
  }
  if (method === 'GET') return json(note)
  if (method === 'PATCH') {
    if (body.body !== undefined && body.body !== note.body && note.summary) {
      note.summary_stale = true
    }
    Object.assign(note, body)
    return json(note)
  }
  if (method === 'DELETE') {
    notes = notes.filter((n) => n.id !== id)
    return json(null, 204)
  }
  return json({ detail: 'Method Not Allowed' }, 405)
}

function renderApp(hash = '') {
  window.history.replaceState(null, '', `/${hash}`)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

// Autosave waits for typing to pause, so give saves a little longer to land
const SAVE = { timeout: 3000 }

beforeEach(() => {
  nextId = 1
  notes = []
  calls = []
  summariseStatus = 200
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writing', () => {
  it('saves a new note by itself and lists it', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Title'), 'Groceries')
    await user.type(screen.getByLabelText('Note'), 'Milk, eggs')

    expect(await screen.findByRole('link', { name: /Groceries/ }, SAVE)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument(), SAVE)
    expect(window.location.hash).toBe('#/notes/1')
    // One note, created once, then edited in place
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ title: 'Groceries', body: 'Milk, eggs' })
    expect(calls.filter((c) => c === 'POST /api/notes')).toHaveLength(1)
    // The editor stayed put: the caret is still in the note
    expect(screen.getByLabelText('Note')).toHaveFocus()
  })

  it("doesn't save a note with no text", async () => {
    const user = userEvent.setup()
    renderApp()

    await user.type(await screen.findByLabelText('Title'), 'Just a title')
    expect(await screen.findByText('Write something to save this note', {}, SAVE)).toBeInTheDocument()
    expect(notes).toHaveLength(0)
  })

  it('saves edits when you switch to another note', async () => {
    notes = [makeNote('First', 'One'), makeNote('Second', 'Two')]
    const user = userEvent.setup()
    renderApp('#/notes/1')

    const body = await screen.findByDisplayValue('One')
    await user.type(body, ' more')
    await user.click(screen.getByRole('link', { name: /Second/ }))

    expect(await screen.findByDisplayValue('Two')).toBeInTheDocument()
    await waitFor(() => expect(notes[0].body).toBe('One more'))
  })
})

describe('summaries', () => {
  it('summarises a note and marks the summary out of date after an edit', async () => {
    notes = [makeNote('Trip', 'Flights on Friday')]
    const user = userEvent.setup()
    renderApp('#/notes/1')

    await user.click(await screen.findByRole('button', { name: 'Summarise' }))
    expect(await screen.findByText('Summary of Trip.')).toBeInTheDocument()
    expect(screen.queryByText(/out of date/)).toBeNull()

    const body = screen.getByLabelText('Note')
    await user.clear(body)
    await user.type(body, 'Flights on Saturday')

    expect(await screen.findByText(/This summary is out of date/, {}, SAVE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarise again' })).toBeInTheDocument()
  })

  it.each([
    [503, "Can't reach Ollama. Is it running?"],
    [502, 'Ollama returned an error (404). Check that the model is pulled in Ollama.'],
  ])('explains a %i from summarise', async (status, message) => {
    notes = [makeNote('Note', 'Body')]
    summariseStatus = status
    const user = userEvent.setup()
    renderApp('#/notes/1')

    await user.click(await screen.findByRole('button', { name: 'Summarise' }))
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(await within(summary).findByRole('alert')).toHaveTextContent(message)
  })
})

describe('finding and tidying', () => {
  it('lists newest first and filters by search', async () => {
    notes = [makeNote('Older', 'about cats'), makeNote('Newer', 'about dogs')]
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('navigation', { name: 'Notes' })
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(2))
    const titles = within(list)
      .getAllByRole('link')
      .map((a) => a.querySelector('.row-title')?.textContent)
    expect(titles).toEqual(['Newer', 'Older'])

    await user.type(screen.getByLabelText('Search notes'), 'cats')
    await waitFor(() => expect(within(list).queryByRole('link', { name: /Newer/ })).toBeNull())
    expect(within(list).getByRole('link', { name: /Older/ })).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Search notes'))
    await user.type(screen.getByLabelText('Search notes'), 'zebras')
    expect(await screen.findByText(/No notes match/)).toBeInTheDocument()
  })

  it('groups notes under when they were written', async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    notes = [
      makeNote('Old idea', 'From last week', { created_at: daysAgo(9) }),
      makeNote('Dentist', 'Booked', { created_at: daysAgo(3) }),
      makeNote('Rent', 'Pay Sam', { created_at: daysAgo(1) }),
      makeNote('Lisbon', 'Flights', { created_at: daysAgo(0) }),
    ]
    renderApp()

    const list = await screen.findByRole('navigation', { name: 'Notes' })
    await waitFor(() => expect(within(list).getAllByRole('heading')).toHaveLength(4))
    const headings = within(list)
      .getAllByRole('heading')
      .map((h) => h.textContent)
    expect(headings).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Last 30 days'])
    const yesterday = within(list).getByRole('region', { name: 'Yesterday' })
    expect(within(yesterday).getByRole('link', { name: /Rent/ })).toBeInTheDocument()
  })

  it('asks before deleting a note', async () => {
    notes = [makeNote('Temp', 'Delete me')]
    const user = userEvent.setup()
    renderApp('#/notes/1')

    await screen.findByDisplayValue('Temp')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(notes).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Delete this note?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument()
    expect(notes).toHaveLength(0)
    expect(window.location.hash).toBe('#/')
  })

  it('says so when a note no longer exists', async () => {
    renderApp('#/notes/42')
    expect(await screen.findByText('This note no longer exists.')).toBeInTheDocument()
  })
})

describe('the shell', () => {
  it('toggles focus mode from the button and the keyboard', async () => {
    notes = [makeNote('Note', 'Body')]
    const user = userEvent.setup()
    const { container } = renderApp('#/notes/1')
    const app = container.querySelector('.app')!

    await user.click(await screen.findByRole('button', { name: 'Focus' }))
    expect(app).toHaveAttribute('data-focus', 'on')
    await user.keyboard('{Escape}')
    expect(app).not.toHaveAttribute('data-focus')
    await user.keyboard('{Control>}.{/Control}')
    expect(app).toHaveAttribute('data-focus', 'on')
  })

  it('shows a retryable error when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderApp()

    const alert = await screen.findByText(/Couldn't load your notes/)
    expect(alert).toHaveTextContent("Can't reach the server")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
