/**
 * The password rules that the sign-up, reset and account forms show as live
 * checks, and that the server actions enforce. No imports: client components
 * use it too.
 */

export const PASSWORD_MIN_LENGTH = 8

// The most used passwords of 8 or more characters. A short list on purpose:
// it catches the obvious ones without shipping a dictionary to the browser.
const COMMON = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  'iloveyou',
  'qwertyuiop',
  'qwerty123',
  'qwerty12',
  '1q2w3e4r',
  '1q2w3e4r5t',
  'zaq12wsx',
  'abc12345',
  'abcd1234',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'welcome1',
  'welcome123',
  'superman',
  'trustno1',
  'whatever',
  'letmein1',
  'starwars',
  'michelle',
  'jennifer',
  'computer',
  'internet',
  'asdfghjkl',
  'asdf1234',
  'master123',
  'dragon123',
  'monkey123',
  '11111111',
  '00000000',
  '88888888',
  '87654321',
  'aaaaaaaa',
  'changeme',
  'administrator',
  'admin123',
  'hachiman',
  'takusen',
])

export interface PasswordChecks {
  length: boolean
  notEmail: boolean
  notCommon: boolean
}

export type PasswordStrengthLabel = 'Weak' | 'Fair' | 'Good' | 'Strong'

export interface PasswordStrength {
  checks: PasswordChecks
  /** 0 to 4: the number of filled bars. */
  score: number
  label: PasswordStrengthLabel
}

const LABELS: PasswordStrengthLabel[] = ['Weak', 'Weak', 'Fair', 'Good', 'Strong']

export function passwordChecks(password: string, email: string): PasswordChecks {
  const lower = password.toLowerCase()
  const e = email.trim().toLowerCase()
  const local = e.split('@')[0] ?? ''
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    notEmail: lower !== e && (local.length < 3 || !lower.includes(local)),
    notCommon: !COMMON.has(lower),
  }
}

export function passwordStrength(password: string, email: string): PasswordStrength {
  const checks = passwordChecks(password, email)
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  const varied = password.length >= 12 || (password.length >= PASSWORD_MIN_LENGTH && classes >= 3)
  const score = password === '' ? 0 : [checks.length, checks.notEmail, checks.notCommon, varied].filter(Boolean).length
  return { checks, score, label: LABELS[score] ?? 'Weak' }
}

/** The first failed rule as a sentence, or null. The length rule stays with the zod schemas. */
export function passwordProblem(password: string, email: string): string | null {
  const c = passwordChecks(password, email)
  if (!c.notEmail) return 'Choose a password that does not contain your email'
  if (!c.notCommon) return 'This password is too common. Choose another one'
  return null
}
