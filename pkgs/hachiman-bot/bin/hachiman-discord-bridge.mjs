#!/usr/bin/env node
// The package ships TypeScript source: tsx loads it.
import { register } from 'tsx/esm/api'
register()
await import('../src/cli.ts')
