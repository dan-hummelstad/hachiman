import Link from 'next/link'

/** "Question? Link" line for an auth window's footer strip. */
export function AuthFooterLink({
  prompt,
  href,
  children,
}: {
  prompt: string
  href: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p className="text-muted-foreground">
      {prompt}{' '}
      <Link href={href} className="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground">
        {children}
      </Link>
    </p>
  )
}
