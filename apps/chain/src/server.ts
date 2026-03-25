import Fastify from 'fastify'
import { positionRoutes } from './routes/position.js'
import { executeRoutes } from './routes/execute.js'
import { mintRoutes } from './routes/mint.js'
import { poolRoutes } from './routes/pool.js'

export async function buildServer() {
  const server = Fastify({
    logger: true,
  })

  await server.register(positionRoutes, { prefix: '/positions' })
  await server.register(executeRoutes, { prefix: '/execute' })
  await server.register(mintRoutes, { prefix: '/mint' })
  await server.register(poolRoutes, { prefix: '/pool' })

  server.get('/health', async () => ({ status: 'ok' }))

  return server
}
