import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { query, withTransaction } from './db.js';
import { ROLE_DEFINITIONS, type CurrentUser, type Permission, type RoleKey } from '../../../packages/shared/src/index.js';

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 8);
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS ?? 5);
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES ?? 15);
const COOKIE_NAME = 'cfiscon_session';

export function sessionCookieName(): string {
  return COOKIE_NAME;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function currentUserFromRequest(request: FastifyRequest): Promise<CurrentUser | null> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  const result = await query<CurrentUser & { role_key: RoleKey; role_name: string }>(
    `SELECT u.id, u.name, u.username, u.email, u.role_key, r.name AS role_label
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.key = s.role_key
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashToken(token)]
  );
  if (!result.rows[0]) return null;
  await query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hashToken(token)]);
  const role = result.rows[0].role_key;
  return { ...result.rows[0], permissions: [...ROLE_DEFINITIONS[role].permissions] as Permission[] };
}

export function requireUser(request: FastifyRequest, reply: FastifyReply, permission?: Permission): Promise<CurrentUser | null> {
  return currentUserFromRequest(request).then((user) => {
    if (!user) {
      void reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Sessão necessária.' } });
      return null;
    }
    if (permission && !user.permissions.includes(permission)) {
      void reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente para esta ação.' } });
      return null;
    }
    return user;
  });
}

export async function login(username: string, password: string, request: FastifyRequest, reply: FastifyReply): Promise<CurrentUser | null> {
  const normalized = username.trim().toLowerCase();
  const result = await query<{ id: string; name: string; username: string; email: string | null; password_hash: string | null; role_key: RoleKey; active: boolean; failed_login_attempts: number; locked_until: Date | null }>(
    `SELECT id, name, username, email, password_hash, role_key, active, failed_login_attempts, locked_until
     FROM users WHERE lower(username) = $1`,
    [normalized]
  );
  const user = result.rows[0];
  const now = new Date();
  if (!user || !user.active || (user.locked_until && user.locked_until > now) || !user.password_hash || !(await verifyPassword(user.password_hash, password))) {
    if (user) {
      const attempts = user.failed_login_attempts + 1;
      const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) : null;
      await query('UPDATE users SET failed_login_attempts = $1, locked_until = $2, updated_at = now() WHERE id = $3', [lockUntil ? 0 : attempts, lockUntil, user.id]);
      await query('INSERT INTO audit_events (actor_id, actor_username, role_key, action, entity, entity_id, result, origin, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.username, user.role_key, 'LOGIN_NEGADO', 'User', user.id, 'failure', request.ip, 'Credencial inválida ou conta bloqueada.']);
    } else {
      await query('INSERT INTO audit_events (actor_username, action, entity, result, origin, details) VALUES ($1,$2,$3,$4,$5,$6)', [normalized, 'LOGIN_NEGADO', 'User', 'failure', request.ip, 'Usuário inexistente.']);
    }
    return null;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60_000);
  const current = await withTransaction(async (client) => {
    await client.query('UPDATE sessions SET expires_at = now() WHERE user_id = $1 AND expires_at > now()', [user.id]);
    await client.query('INSERT INTO sessions (token_hash, user_id, role_key, expires_at) VALUES ($1,$2,$3,$4)', [tokenHash, user.id, user.role_key, expiresAt]);
    await client.query('UPDATE users SET failed_login_attempts = 0, locked_until = null, last_login_at = now(), updated_at = now() WHERE id = $1', [user.id]);
    await client.query('INSERT INTO audit_events (actor_id, actor_username, role_key, action, entity, entity_id, result, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, user.username, user.role_key, 'LOGIN_SUCESSO', 'User', user.id, 'success', request.ip]);
    return user;
  });
  reply.setCookie(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: expiresAt });
  return { id: current.id, name: current.name, username: current.username, email: current.email, role_key: current.role_key, role_label: ROLE_DEFINITIONS[current.role_key].label, permissions: [...ROLE_DEFINITIONS[current.role_key].permissions] as Permission[] };
}

export async function createVisitor(request: FastifyRequest, reply: FastifyReply): Promise<CurrentUser | null> {
  const result = await query<{ id: string; name: string; username: string; email: string | null; role_key: RoleKey }>('SELECT id, name, username, email, role_key FROM users WHERE username = $1 AND active = true', ['visitante']);
  const visitor = result.rows[0];
  if (!visitor) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.min(SESSION_TTL_HOURS, 2) * 60 * 60_000);
  await query('INSERT INTO sessions (token_hash, user_id, role_key, expires_at) VALUES ($1,$2,$3,$4)', [hashToken(token), visitor.id, visitor.role_key, expiresAt]);
  await query('INSERT INTO audit_events (actor_id, actor_username, role_key, action, entity, entity_id, result, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [visitor.id, visitor.username, visitor.role_key, 'LOGIN_VISITANTE', 'User', visitor.id, 'success', request.ip]);
  reply.setCookie(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: expiresAt });
  return { id: visitor.id, name: visitor.name, username: visitor.username, email: visitor.email, role_key: visitor.role_key, role_label: ROLE_DEFINITIONS[visitor.role_key].label, permissions: [...ROLE_DEFINITIONS[visitor.role_key].permissions] as Permission[] };
}

export async function logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[COOKIE_NAME];
  if (token) {
    const user = await currentUserFromRequest(request);
    await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    if (user) await query('INSERT INTO audit_events (actor_id, actor_username, role_key, action, entity, entity_id, result, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, user.username, user.role_key, 'LOGOUT', 'User', user.id, 'success', request.ip]);
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}
