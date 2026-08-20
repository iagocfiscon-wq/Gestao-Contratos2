import { describe, expect, it, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';

describe('API C-FISCON', () => {
  const servers: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => { for (const server of servers) await server.close(); servers.length = 0; });

  it('responde health sem depender do banco', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'cfiscon-api' });
  });
});
