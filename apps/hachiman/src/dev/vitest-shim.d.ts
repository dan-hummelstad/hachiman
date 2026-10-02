// ponytail: apps/hachiman has no vitest devDependency yet, so tsgo cannot resolve 'vitest' for the
// *.test.ts files here. This declares the small part of its API that those tests use. Delete this
// file when package.json gets vitest (and a "test" script); the tests then typecheck against the
// real types. The tests run with ../dev/vitest.config.ts (see there).
declare module 'vitest' {
  interface Assertion<T> {
    not: Assertion<T>
    resolves: Assertion<Awaited<T>> & PromiseLike<void>
    rejects: Assertion<unknown> & PromiseLike<void>
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toStrictEqual(expected: unknown): void
    toBeNull(): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeTruthy(): void
    toBeFalsy(): void
    toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void
    toContain(expected: unknown): void
    toHaveLength(expected: number): void
    toMatchObject(expected: object): void
    toThrow(expected?: string | RegExp | (abstract new (...args: never[]) => unknown)): void
    toHaveBeenCalled(): void
    toHaveBeenCalledTimes(expected: number): void
    toHaveBeenCalledWith(...args: unknown[]): void
  }
  interface Mock<A extends unknown[] = unknown[], R = unknown> {
    (...args: A): R
    mock: { calls: A[]; results: { type: string; value: R }[] }
    mockImplementation(fn: (...args: A) => R): Mock<A, R>
    mockResolvedValue(value: Awaited<R>): Mock<A, R>
    mockReturnValue(value: R): Mock<A, R>
  }
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>): void
  export const test: typeof it
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  export function expect<T>(actual: T): Assertion<T>
  export const vi: {
    fn<A extends unknown[] = unknown[], R = unknown>(impl?: (...args: A) => R): Mock<A, R>
  }
}
