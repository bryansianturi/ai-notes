import { describe, expect, it } from 'vitest'
import { dateGroup, groupByDate, rowDate } from './format.ts'

// Wednesday 10 Nov 2026, mid-afternoon local time
const now = new Date(2026, 10, 10, 15, 0)
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString()

describe('dateGroup', () => {
  it.each([
    [at(2026, 10, 10, 0), 'Today'],
    [at(2026, 10, 10, 23), 'Today'],
    [at(2026, 10, 9, 23), 'Yesterday'],
    [at(2026, 10, 9, 0), 'Yesterday'],
    [at(2026, 10, 8), 'Last 7 days'],
    [at(2026, 10, 4), 'Last 7 days'],
    [at(2026, 10, 3), 'Last 30 days'],
    [at(2026, 9, 12), 'Last 30 days'],
    [at(2026, 9, 11), 'October'],
    [at(2026, 0, 5), 'January'],
    [at(2025, 11, 31), 'December 2025'],
  ])('puts %s under %s', (iso, label) => {
    expect(dateGroup(iso, now)).toBe(label)
  })
})

describe('rowDate', () => {
  it('shows only the time for today and yesterday', () => {
    expect(rowDate(at(2026, 10, 10, 9), now)).toMatch(/9/)
    expect(rowDate(at(2026, 10, 9, 9), now)).not.toBe('Yesterday')
  })

  it('shows the day further back', () => {
    expect(rowDate(at(2026, 10, 6), now)).toBe('Friday')
  })
})

describe('groupByDate', () => {
  it('keeps newest-first order and splits into runs', () => {
    const notes = [
      { id: 1, created_at: at(2026, 10, 10, 14) },
      { id: 2, created_at: at(2026, 10, 10, 8) },
      { id: 3, created_at: at(2026, 10, 9) },
      { id: 4, created_at: at(2026, 9, 1) },
    ]
    expect(
      groupByDate(notes, now).map((g) => [g.label, g.items.map((n) => n.id)]),
    ).toEqual([
      ['Today', [1, 2]],
      ['Yesterday', [3]],
      ['October', [4]],
    ])
  })
})
