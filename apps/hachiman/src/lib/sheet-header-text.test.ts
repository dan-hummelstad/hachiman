import { createElement, Fragment } from 'react'
import { describe, expect, it } from 'vitest'
import { sheetHeaderText, type SheetHeaderText } from './sheet-header-text'

const Title = ({ children }: { children?: React.ReactNode }): React.ReactNode => children
const Description = ({ children }: { children?: React.ReactNode }): React.ReactNode => children
const title = (text: string): React.ReactElement => createElement(Title, null, text)
const description = (text: string): React.ReactElement => createElement(Description, null, text)
const text = (...children: React.ReactNode[]): SheetHeaderText | null =>
  sheetHeaderText(createElement(Fragment, null, ...children).props.children, Title, Description)

describe('sheetHeaderText', () => {
  it('takes a title alone', () => {
    expect(text(title('Leave guild'))).toEqual({ title: 'Leave guild', subtitle: undefined })
  })

  it('takes a title and a description', () => {
    expect(text(title('Invite'), description('Expires in 7 days'))).toEqual({
      title: 'Invite',
      subtitle: 'Expires in 7 days'
    })
  })

  it('skips an empty `{subtitle && …}`', () => {
    expect(text(title('Invite'), '')).toEqual({ title: 'Invite', subtitle: undefined })
  })

  it('returns null for any other child', () => {
    expect(text(title('Invite'), createElement('span', null, 'x'))).toBeNull()
    expect(text(title('Invite'), 'plain text')).toBeNull()
    expect(text(title('One'), title('Two'))).toBeNull()
    expect(text(title('One'), description('a'), description('b'))).toBeNull()
  })

  it('returns null without a title', () => {
    expect(text(description('Only a subtitle'))).toBeNull()
    expect(text()).toBeNull()
  })
})
