import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000
const PUBLIC_PATHS = new Set<string>(['/health'])

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export async function registerHmacAuth(
  fastify: FastifyInstance,
  secret: string,
): Promise<void> {
  // Capture raw body so HMAC is computed on the exact bytes the api signed,
  // not on a re-serialised JSON that may differ in whitespace or key order.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      ;(req as FastifyRequest).rawBody = (body as string) ?? ''
      const text = body as string
      if (!text) {
        done(null, undefined)
        return
      }
      try {
        done(null, JSON.parse(text))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  fastify.addHook('preValidation', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (PUBLIC_PATHS.has(path)) return

    const tsHeader = req.headers['x-timestamp']
    const sigHeader = req.headers['x-signature']
    const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader

    if (!timestamp || !signature) {
      reply.code(401).send({ error: 'Missing X-Timestamp or X-Signature header' })
      return
    }

    const tsMs = Number(timestamp)
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_TOLERANCE_MS) {
      reply.code(401).send({ error: 'Timestamp out of tolerance window' })
      return
    }

    const method = req.method.toUpperCase()
    const fullPath = req.url
    const bodyHash = sha256Hex(req.rawBody ?? '')
    const canonical = `${timestamp}\n${method}\n${fullPath}\n${bodyHash}`
    const expected = hmacSha256Hex(secret, canonical)

    if (!safeEqualHex(expected, signature)) {
      reply.code(401).send({ error: 'Invalid signature' })
      return
    }
  })
}
