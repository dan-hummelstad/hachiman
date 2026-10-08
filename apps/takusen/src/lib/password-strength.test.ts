/** The password rules of the sign-up, reset and account forms (password-strength.ts). */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { passwordChecks, passwordProblem, passwordStrength } from './password-strength'

describe('passwordChecks', () => {
  test('length, email and common-password rules', () => {
    assert.deepEqual(passwordChecks('short', 'kestrel@example.com'), { length: false, notEmail: true, notCommon: true })
    assert.equal(passwordChecks('Kestrel@example.com', 'kestrel@example.com').notEmail, false)
    assert.equal(passwordChecks('mykestrel99', 'kestrel@example.com').notEmail, false)
    assert.equal(passwordChecks('Password123', 'a@b.c').notCommon, false)
  })

  test('a local part shorter than 3 characters does not count', () => {
    assert.equal(passwordChecks('jo-river-stone', 'jo@example.com').notEmail, true)
  })
})

describe('passwordStrength', () => {
  test('score and label', () => {
    assert.equal(passwordStrength('', 'a@b.c').score, 0)
    assert.equal(passwordStrength('password', 'a@b.c').label, 'Fair')
    assert.equal(passwordStrength('quiet-harbor-lamp', 'a@b.c').label, 'Strong')
    assert.equal(passwordStrength('Tr0ub4dor', 'a@b.c').score, 4)
  })
})

describe('passwordProblem', () => {
  test('the first failed rule, or null', () => {
    assert.match(passwordProblem('kestrel2026', 'kestrel@example.com') ?? '', /email/)
    assert.match(passwordProblem('iloveyou', 'a@b.c') ?? '', /common/)
    assert.equal(passwordProblem('quiet-harbor-lamp', 'kestrel@example.com'), null)
  })
})
