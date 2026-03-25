import type { FastifyPluginAsync } from 'fastify'
import { getPoolStateByPair } from '../services/uniswap.js'

export const poolRoutes: FastifyPluginAsync = async (server) => {
  // GET /pool?token0=0x...&token1=0x...&fee=500
  server.get<{ Querystring: { token0: string; token1: string; fee: string } }>('/', async (request, reply) => {
    const { token0, token1, fee } = request.query
    if (!token0 || !token1 || !fee) {
      return reply.code(400).send({ error: 'token0, token1, fee are required' })
    }
    return getPoolStateByPair(token0 as `0x${string}`, token1 as `0x${string}`, Number(fee))
  })
}
