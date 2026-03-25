import type { FastifyPluginAsync } from 'fastify'
import { rebalance } from '../services/rebalance.js'
import type { RebalanceRequest } from '@lagrangefi/shared'

// In-memory idempotency store — replace with DB-backed store in production
const processedKeys = new Set<string>()

export const executeRoutes: FastifyPluginAsync = async (server) => {
  // POST /execute/rebalance — remove liquidity, swap, re-add at new range
  server.post<{ Body: RebalanceRequest }>('/rebalance', async (request, reply) => {
    const req = request.body

    if (processedKeys.has(req.idempotencyKey)) {
      return reply.code(409).send({ error: 'Duplicate request', idempotencyKey: req.idempotencyKey })
    }

    processedKeys.add(req.idempotencyKey)

    try {
      const result = await rebalance(req)
      return result
    } catch (err) {
      // Remove key so caller can retry with the same key after fixing the issue
      processedKeys.delete(req.idempotencyKey)
      throw err
    }
  })
}
