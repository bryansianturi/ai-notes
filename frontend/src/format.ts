const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// "3:41 PM", "Yesterday", "Tuesday", "Nov 3", or "Nov 3, 2025": the shortest that's still clear
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return time.format(d)
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekday.format(d)
  if (d.getFullYear() === now.getFullYear()) return monthDay.format(d)
  return full.format(d)
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

const monthName = new Intl.DateTimeFormat(undefined, { month: 'long' })
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

function daysAgo(d: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
}

// Which heading a note sits under in the list
export function dateGroup(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const days = daysAgo(d, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Last 7 days'
  if (days < 30) return 'Last 30 days'
  if (d.getFullYear() === now.getFullYear()) return monthName.format(d)
  return monthYear.format(d)
}

// The date beside a note in the list. Under "Today" or "Yesterday" the time is enough.
export function rowDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  return daysAgo(d, now) <= 1 ? time.format(d) : shortDate(iso, now)
}

// Split a newest-first list into runs that share a heading
export function groupByDate<T extends { created_at: string }>(
  items: T[],
  now = new Date(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = []
  for (const item of items) {
    const label = dateGroup(item.created_at, now)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}
