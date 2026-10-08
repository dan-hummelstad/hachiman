import assert from 'node:assert/strict'
import { test } from 'node:test'

import { daysAgo, passwordAge, timeAgo } from './format'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const MIN = 60_000
const DAY = 24 * 60 * MIN

test('timeAgo', () => {
  assert.equal(timeAgo(ago(10_000), NOW), 'now')
  assert.equal(timeAgo(ago(5 * MIN), NOW), '5 min ago')
  assert.equal(timeAgo(ago(2 * 60 * MIN), NOW), '2 h ago')
  assert.equal(timeAgo(ago(DAY + MIN), NOW), 'yesterday')
  assert.equal(timeAgo(ago(12 * DAY), NOW), '12 days ago')
  // A clock skew into the future still reads as now.
  assert.equal(timeAgo(ago(-MIN), NOW), 'now')
})

test('daysAgo falls back to a date after 60 days', () => {
  assert.equal(daysAgo(ago(90 * DAY), NOW), 'on 10 Jul 2026')
})

test('passwordAge', () => {
  const created = ago(30 * DAY)
  assert.equal(passwordAge(null, created, NOW), 'Set')
  assert.equal(passwordAge(created, created, NOW), 'Set 30 days ago')
  assert.equal(passwordAge(ago(12 * DAY), created, NOW), 'Changed 12 days ago')
})
