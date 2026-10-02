/**
 * A private local stack for the cross-client call test (calls.test.mts):
 * Takusen (Next.js + management gRPC), hachiman-gateway, hachiman-media and the browser host
 * (Vite), on their own ports, with their own Postgres database, Redis db and S3 bucket.
 *
 * It never touches the dev database, Redis db 0 or the dev bucket. It does not read the repo
 * .env: every variable is set here, so a dev .env cannot leak into the test.
 *
 * Docker containers of docker/docker-compose.yml must run (Postgres, Redis, SeaweedFS).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(import.meta.dirname, '../..')

const env = process.env
export const CFG = {
  takusenPort: Number(env.E2EE_CALLS_TAKUSEN_PORT ?? 3200),
  grpcPort: Number(env.E2EE_CALLS_GRPC_PORT ?? 50251),
  gatewayPort: Number(env.E2EE_CALLS_GATEWAY_PORT ?? 8280),
  mediaPort: Number(env.E2EE_CALLS_MEDIA_PORT ?? 8290),
  webPort: Number(env.E2EE_CALLS_WEB_PORT ?? 5273),
  db: env.E2EE_CALLS_DB ?? 'hachiman_e2ee_calls',
  pgContainer: env.E2EE_CALLS_PG_CONTAINER ?? 'hachiman-postgres',
  /** The superuser of the Postgres container (POSTGRES_USER of the compose file). */
  pgUser: env.E2EE_CALLS_PG_USER ?? 'takusen',
  pgPassword: env.E2EE_CALLS_PG_PASSWORD ?? env.E2EE_CALLS_PG_USER ?? 'takusen',
  redisContainer: env.E2EE_CALLS_REDIS_CONTAINER ?? 'hachiman-redis',
  redisDb: Number(env.E2EE_CALLS_REDIS_DB ?? 14),
  s3Container: env.E2EE_CALLS_S3_CONTAINER ?? 'hachiman-seaweedfs',
  bucket: env.E2EE_CALLS_BUCKET ?? 'hachiman-e2ee-calls',
  dir: env.E2EE_CALLS_DIR ?? join(tmpdir(), 'hachiman-e2ee-calls')
}

if (CFG.db === 'takusen' || CFG.redisDb === 0 || CFG.bucket === 'hachiman-uploads') {
  throw new Error('e2e/calls: refusing to use the dev database, Redis db 0 or the dev bucket')
}

const takusenUrl = `http://localhost:${CFG.takusenPort}`
export const WEB_URL = `http://localhost:${CFG.webPort}`
export const TAKUSEN_URL = takusenUrl

/** The environment of every process of the stack. */
export function stackEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, TMPDIR, USER, SHELL, LANG } = process.env
  return {
    PATH,
    HOME,
    TMPDIR,
    USER,
    SHELL,
    LANG,
    GOCACHE: process.env.GOCACHE,
    GOFLAGS: process.env.GOFLAGS,
    CGO_ENABLED: '0',
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: `postgres://${CFG.pgUser}:${CFG.pgPassword}@localhost:5432/${CFG.db}`,
    REDIS_URL: `redis://localhost:6379/${CFG.redisDb}`,
    TAKUSEN_GRPC_ADDR: `127.0.0.1:${CFG.grpcPort}`,
    TAKUSEN_GRPC_PORT: String(CFG.grpcPort),
    VOICE_KEY: join(CFG.dir, 'keys/voice-signer.ed25519'),
    S3_ENDPOINT: 'http://localhost:8333',
    S3_REGION: 'us-east-1',
    S3_BUCKET: CFG.bucket,
    S3_ACCESS_KEY_ID: 'hachiman',
    S3_SECRET_ACCESS_KEY: 'hachiman-dev-secret',
    S3_FORCE_PATH_STYLE: 'true',
    AUTH_SECRET: 'e2ee-calls-only-auth-secret-0123456789abcdef0123456789',
    NEXTAUTH_URL: takusenUrl,
    AUTH_URL: takusenUrl,
    OIDC_ISSUER_URL: `${takusenUrl}/api/oidc`,
    OIDC_COOKIES_KEY: 'e2ee-calls-only-oidc-cookie-key-0123456789abcdef',
    TAKUSEN_ALLOWED_ORIGINS: `${WEB_URL},http://127.0.0.1:${CFG.webPort},hachiman://app`,
    HACHIMAN_WEB_URL: WEB_URL,
    HACHIMAN_CLIENT_REDIRECT_URIS: [
      `${WEB_URL}/oauth/callback`,
      `${takusenUrl}/oauth/electron-bridge`,
      'app.hachiman://oauth-callback'
    ].join(','),
    TAKUSEN_MAX_UPLOAD_BYTES: '26214400',
    TAKUSEN_DS_SIGNING_KEY: join(CFG.dir, 'keys/takusen-ds.ed25519'),
    TAKUSEN_KT_SIGNING_KEY: join(CFG.dir, 'keys/takusen-kt.ed25519'),
    TAKUSEN_MLS_SUITES: '1',
    TAKUSEN_MLS_BATCH_INTERVAL_MS: '1000',
    TAKUSEN_MLS_BATCH_TIMEOUT_MS: '5000',
    GATEWAY_LISTEN_ADDR: `:${CFG.gatewayPort}`,
    TAKUSEN_URL: takusenUrl,
    GATEWAY_MIN_CLIENT_VERSION: '0.1.0',
    MEDIA_NODE_ID: 'media-e2ee-calls',
    MEDIA_REGION: 'us-east',
    MEDIA_WS_READ_LIMIT: '1048576',
    VITE_TAKUSEN_OIDC_ISSUER: `${takusenUrl}/api/oidc`,
    VITE_TAKUSEN_OIDC_CLIENT_ID: 'hachiman-client',
    VITE_TAKUSEN_API_BASE: `${takusenUrl}/api`,
    VITE_HACHIMAN_GATEWAY_URL: `ws://localhost:${CFG.gatewayPort}/gateway`
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): string {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: stackEnv(),
    input: opts.input,
    encoding: 'utf8'
  })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

function psql(sql: string): void {
  run('docker', ['exec', CFG.pgContainer, 'psql', '-U', CFG.pgUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql])
}

/** A fresh database, Redis db and bucket; migrations and the seed (OIDC client, regions). */
export function prepareData(): void {
  mkdirSync(join(CFG.dir, 'keys'), { recursive: true })
  mkdirSync(join(CFG.dir, 'logs'), { recursive: true })
  psql(`DROP DATABASE IF EXISTS ${CFG.db} WITH (FORCE)`)
  psql(`CREATE DATABASE ${CFG.db}`)
  run('docker', ['exec', CFG.redisContainer, 'redis-cli', '-n', String(CFG.redisDb), 'FLUSHDB'])
  run('docker', ['exec', '-i', CFG.s3Container, 'weed', 'shell', '-master=localhost:9333'], {
    input: `s3.bucket.create -name ${CFG.bucket}\n`
  })
  const takusen = join(ROOT, 'apps/takusen')
  run('node', ['--import', 'tsx', 'src/db/migrate.ts'], { cwd: takusen })
  run('node', ['--import', 'tsx', 'src/db/seed.ts'], { cwd: takusen })
}

/** go build of the gateway and the media node into the stack dir. */
export function buildServer(): { gateway: string; media: string } {
  const bin = join(CFG.dir, 'bin')
  run('go', ['build', '-o', bin + '/', './cmd/hachiman-gateway', './cmd/hachiman-media'], {
    cwd: join(ROOT, 'apps/hachiman-server')
  })
  return { gateway: join(bin, 'hachiman-gateway'), media: join(bin, 'hachiman-media') }
}

function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((ok, fail) => {
    const attempt = (): void => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        ok()
      })
      s.once('error', () => {
        s.destroy()
        if (Date.now() > deadline) fail(new Error(`port ${port} did not open`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

export interface Stack {
  stop(): Promise<void>
  logDir: string
}

/** Starts every process and waits until each one answers. */
export async function startStack(): Promise<Stack> {
  prepareData()
  const bins = buildServer()
  const logDir = join(CFG.dir, 'logs')
  const procs: ChildProcess[] = []
  const start = (name: string, cmd: string, args: string[], cwd: string): void => {
    const log = createWriteStream(join(logDir, `${name}.log`))
    const p = spawn(cmd, args, { cwd, env: stackEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    p.stdout!.pipe(log)
    p.stderr!.pipe(log)
    p.on('exit', (code, sig) => {
      if (!stopping) console.error(`[stack] ${name} exited (${code ?? sig}); see ${join(logDir, name + '.log')}`)
    })
    procs.push(p)
  }
  let stopping = false
  const takusen = join(ROOT, 'apps/takusen')
  const server = join(ROOT, 'apps/hachiman-server')

  start('takusen-grpc', 'node', ['--import', 'tsx', 'src/grpc/main.ts'], takusen)
  start('takusen-next', join(takusen, 'node_modules/.bin/next'), ['dev', '-p', String(CFG.takusenPort)], takusen)
  start('web', join(ROOT, 'apps/hachiman-browser/node_modules/.bin/vite'), ['--port', String(CFG.webPort), '--strictPort'], join(ROOT, 'apps/hachiman-browser'))
  const stop = async (): Promise<void> => {
    stopping = true
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
    for (const p of procs) {
      try {
        if (p.pid && p.exitCode === null) process.kill(-p.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  try {
    await waitPort(CFG.grpcPort, 60_000)
    start('gateway', bins.gateway, [], server)
    // The gateway writes the voice-token key on start; media reads it.
    await waitHttp(`http://localhost:${CFG.gatewayPort}/healthz`, 60_000)
    start('media', bins.media, ['--listen', `:${CFG.mediaPort}`, '--signaling-url', `ws://localhost:${CFG.mediaPort}/voice`], server)
    await waitHttp(`${takusenUrl}/api/oidc/.well-known/openid-configuration`, 180_000)
    await waitHttp(`http://localhost:${CFG.gatewayPort}/healthz`, 60_000)
    await waitHttp(`http://localhost:${CFG.mediaPort}/healthz`, 60_000)
    await waitHttp(WEB_URL, 60_000)
    // Next dev compiles each route on first use: warm the pages of the sign-in flow.
    for (const path of ['/signup', '/login', '/api/v1/users/@me']) await waitHttp(takusenUrl + path, 180_000)
  } catch (e) {
    await stop()
    throw e
  }
  return { stop, logDir }
}

// `node --experimental-strip-types e2e/calls/stack.mts`: start the stack and keep it up.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startStack()
  console.log(`[stack] up: web ${WEB_URL}, takusen ${takusenUrl}; logs in ${s.logDir}`)
  const down = (): void => void s.stop().then(() => process.exit(0))
  process.on('SIGINT', down)
  process.on('SIGTERM', down)
}
