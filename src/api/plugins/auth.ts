import { type FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../config.js';

export async function registerAuthPlugin(app: FastifyInstance): Promise<void> {
  const config: AppConfig = loadConfig();

  app.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      return reply.status(401).send({ error: 'API key requerida', message: 'El header X-API-Key es obligatorio' });
    }

    const validKeys = config.apiKeys.allowedKeys;

    if (validKeys.length > 0 && !validKeys.includes(apiKey)) {
      return reply.status(401).send({ error: 'API key inválida' });
    }
  });
}
