import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from './Editor.tsx'
import Sidebar from './Sidebar.tsx'

// The open note lives in the URL hash, so reloads and the back button work:
//   #/          a blank page (on phones: the list)
//   #/new       a blank page
//   #/notes/12  note 12
type Route = { kind: 'home' } | { kind: 'new' } | { kind: 'note'; id: number }

function parseHash(hash: string): Route {
  const match = hash.match(/^#\/notes\/(\d+)$/)
  if (match) return { kind: 'note', id: Number(match[1]) }
  if (hash === '#/new') return { kind: 'new' }
  return { kind: 'home' }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export default function App() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash))
  // A new key opens a fresh editor. A draft that gets saved keeps its key, so the caret stays put.
  const [editorKey, setEditorKey] = useState(0)
  const [focusMode, setFocusMode] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHash(window.location.hash))
      setEditorKey((k) => k + 1)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        setFocusMode((f) => !f)
      } else if (e.key === 'Escape') {
        setFocusMode(false)
      } else if (e.key === '/' && !isTyping(e.target)) {
        e.preventDefault()
        setFocusMode(false)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onCreated = useCallback((id: number) => {
    // replaceState doesn't fire hashchange, so the editor isn't reopened mid-sentence
    window.history.replaceState(null, '', `#/notes/${id}`)
    setRoute({ kind: 'note', id })
  }, [])

  const onGone = useCallback(() => {
    window.location.hash = '#/'
  }, [])

  const onNewNote = useCallback(() => {
    setFocusMode(false)
    if (window.location.hash === '#/new') setEditorKey((k) => k + 1)
    else window.location.hash = '#/new'
  }, [])

  const toggleFocus = useCallback(() => setFocusMode((f) => !f), [])

  return (
    <div
      className="app"
      data-view={route.kind === 'home' ? 'list' : 'reader'}
      data-focus={focusMode ? 'on' : undefined}
    >
      <Sidebar
        selectedId={route.kind === 'note' ? route.id : null}
        onNewNote={onNewNote}
        searchRef={searchRef}
      />
      <main className="reader">
        <Editor
          key={editorKey}
          noteId={route.kind === 'note' ? route.id : null}
          onCreated={onCreated}
          onGone={onGone}
          focusMode={focusMode}
          onToggleFocus={toggleFocus}
        />
      </main>
    </div>
  )
}
