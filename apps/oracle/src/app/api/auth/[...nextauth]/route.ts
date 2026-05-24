import { handlers } from '@/auth'

// Re-export Auth.js's Next.js route handlers as the App Router GET/POST exports.
export const { GET, POST } = handlers
