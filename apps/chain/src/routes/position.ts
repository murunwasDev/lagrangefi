import type { FastifyPluginAsync } from 'fastify'
import { getPosition, getPoolState } from '../services/uniswap.js'

export const positionRoutes: FastifyPluginAsync = async (server) => {
  // GET /positions/:tokenId — fetch position data from chain
  server.get<{ Params: { tokenId: string } }>('/:tokenId', async (request, reply) => {
    const { tokenId } = request.params
    const position = await getPosition(BigInt(tokenId))
    return position
  })

  // GET /positions/:tokenId/pool-state — fetch current pool price and tick
  server.get<{ Params: { tokenId: string } }>('/:tokenId/pool-state', async (request, reply) => {
    const { tokenId } = request.params
    const state = await getPoolState(BigInt(tokenId))
    return state
  })
}
