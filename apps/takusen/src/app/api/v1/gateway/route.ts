/**
 * GET /api/v1/gateway — {url}: the gateway that clients connect to (contract §4
 * Gateway discovery), as Discord's GET /gateway. No auth. A bot needs only its
 * token: the token names this server, and this route names the gateway.
 */
import { NextResponse } from 'next/server'

export function GET(): NextResponse {
  const url = process.env.TAKUSEN_PUBLIC_GATEWAY_URL ?? process.env.VITE_HACHIMAN_GATEWAY_URL ?? 'ws://localhost:8080/gateway'
  return NextResponse.json({ url })
}
