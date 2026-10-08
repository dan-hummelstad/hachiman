import { describe, expect, it } from 'vitest'
import { isTextField } from '@/lib/text-field'

describe('isTextField', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}): Element =>
    ({ tagName, ...extra }) as unknown as Element
  it('takes inputs, textareas and contenteditable', () => {
    expect(isTextField(null)).toBe(false)
    expect(isTextField(el('TEXTAREA'))).toBe(true)
    expect(isTextField(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTextField(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTextField(el('DIV', { isContentEditable: true }))).toBe(true)
    expect(isTextField(el('BUTTON'))).toBe(false)
  })
})
