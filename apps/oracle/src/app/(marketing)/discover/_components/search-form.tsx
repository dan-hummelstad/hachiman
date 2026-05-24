'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { SearchIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  initialQuery: string
}

export function SearchForm({ initialQuery }: Props): React.JSX.Element {
  const router = useRouter()
  const params = useSearchParams()
  const [value, setValue] = useState(initialQuery)

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const next = new URLSearchParams(params.toString())
    if (value.trim()) {
      next.set('q', value.trim())
    } else {
      next.delete('q')
    }
    next.delete('page')
    router.push(`/servers?${next.toString()}`)
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-xl items-center gap-2">
      <Input
        type="search"
        placeholder="Search by name or slug…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Search public servers"
      />
      <Button type="submit">
        <SearchIcon /> Search
      </Button>
    </form>
  )
}
