import type { Config } from 'tailwindcss'

// Tailwind v4 reads most config from CSS via `@theme`. This file exists for
// tooling that still expects a config (e.g. some editors / shadcn CLI) and to
// pin the content scan to our App Router source tree.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
