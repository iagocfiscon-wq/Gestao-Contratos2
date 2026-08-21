import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerRoutes } from './routes.js';

export function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 2 * 1024 * 1024 });
  app.register(cookie);
  app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',').map((item) => item.trim()) ?? true, credentials: true });
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_MAX ?? 120), timeWindow: '1 minute' });
  app.register(swagger, { openapi: { info: { title: 'C-FISCON API', version: '1.0.0', description: 'API segura para gestão de contratos administrativos.' }, servers: [{ url: process.env.APP_URL ?? 'http://localhost:3333' }] } });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.setErrorHandler((error: unknown, request, reply) => {
    const typedError = error as { statusCode?: number; message?: string };
    request.log.error({ err: error, path: request.url }, 'request_error');
    const statusCode = typedError.statusCode && typedError.statusCode >= 400 ? typedError.statusCode : 500;
    return reply.code(statusCode).send({ error: { code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: statusCode === 500 ? 'Erro interno. Consulte os logs do servidor.' : typedError.message } });
  });
  void registerRoutes(app);
  return app;
}

const app = buildServer();
const port = Number(process.env.PORT ?? 3333);
const isTestRuntime = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
if (!isTestRuntime) {
  app.listen({ port, host: process.env.HOST ?? '0.0.0.0' }).then(() => app.log.info(`C-FISCON API ouvindo na porta ${port}`)).catch((error) => { app.log.error(error); process.exit(1); });
}

export default app;
