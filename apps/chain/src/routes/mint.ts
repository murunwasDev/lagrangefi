import type { FastifyPluginAsync } from 'fastify'
import { mintPosition } from '../services/mint.js'
import type { MintRequest } from '@lagrangefi/shared'

export const mintRoutes: FastifyPluginAsync = async (server) => {
  server.post<{ Body: MintRequest }>('/', async (request, reply) => {
    const req = request.body
    try {
      const result = await mintPosition(req)
      return result
    } catch (err) {
      server.log.error(err, 'Mint failed')
      return reply.code(500).send({ success: false, txHashes: [], error: String(err) })
    }
  })
}
