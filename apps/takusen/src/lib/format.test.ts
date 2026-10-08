import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatDate, formatDayShort, formatDuration, formatRelative, passwordAge, plural } from './format'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const at = (ms: number): string => new Date(NOW + ms).toISOString()
const MIN = 60_000
const DAY = 24 * 60 * MIN

test('formatRelative, past and future', () => {
  assert.equal(formatRelative(at(0), NOW), 'now')
  assert.equal(formatRelative(at(-3000), NOW), '3 s ago')
  assert.equal(formatRelative(at(-5 * MIN), NOW), '5 min ago')
  assert.equal(formatRelative(at(-2 * 60 * MIN), NOW), '2 h ago')
  assert.equal(formatRelative(at(-DAY - MIN), NOW), 'yesterday')
  assert.equal(formatRelative(at(-12 * DAY), NOW), '12 days ago')
  assert.equal(formatRelative(at(6 * DAY + MIN), NOW), 'in 6 days')
  assert.equal(formatRelative(at(DAY + MIN), NOW), 'tomorrow')
  assert.equal(formatRelative(at(-90 * DAY), NOW), 'on 10 Jul 2026')
})

test('dates use one locale', () => {
  assert.equal(formatDate('2026-08-27T10:00:00Z'), '27 Aug 2026')
  assert.match(formatDayShort('2026-09-29T10:00:00Z'), /^29 Sept?$/)
})

test('formatDuration', () => {
  assert.equal(formatDuration(3600), '1 hour')
  assert.equal(formatDuration(30 * 60), '30 minutes')
  assert.equal(formatDuration(3 * 86_400 + 4 * 3600 + 120), '3 days 4 hours')
  assert.equal(formatDuration(86_400 + 300), '1 day')
  assert.equal(formatDuration(20), '0 minutes')
})

test('plural', () => {
  assert.equal(plural(1, 'session'), '1 session')
  assert.equal(plural(3, 'try', 'tries'), '3 tries')
})

test('passwordAge', () => {
  const created = at(-30 * DAY)
  assert.equal(passwordAge(null, created, NOW), 'Set')
  assert.equal(passwordAge(created, created, NOW), 'Set 30 days ago')
  assert.equal(passwordAge(at(-12 * DAY), created, NOW), 'Changed 12 days ago')
})
