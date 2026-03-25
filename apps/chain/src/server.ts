import Fastify from 'fastify'
import { positionRoutes } from './routes/position.js'
import { executeRoutes } from './routes/execute.js'

export async function buildServer() {
  const server = Fastify({
    logger: true,
  })

  await server.register(positionRoutes, { prefix: '/positions' })
  await server.register(executeRoutes, { prefix: '/execute' })

  server.get('/health', async () => ({ status: 'ok' }))

  return server
}
