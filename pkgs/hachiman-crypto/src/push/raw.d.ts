// Vite's `?raw` import (specs only): push.spec.ts reads the browser service worker as text.
declare module '*?raw' {
  const text: string
  export default text
}
