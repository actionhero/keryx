import { api, Connection } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";

const namespace = "session";
const prefix = `${namespace}` as const;

export interface SessionData<
  T extends Record<string, any> = Record<string, any>,
> {
  id: string;
  cookieName: typeof config.session.cookieName;
  createdAt: number;
  data: T;
}

function getKey(sessionId: Connection["sessionId"]) {
  return `${prefix}:${sessionId}`;
}

/**
 * Load a session from Redis by session ID. Refreshes the TTL on access.
 *
 * @param connection - The connection whose session to load.
 * @returns The parsed session data, or `null` if no session exists.
 */
async function load<T extends Record<string, any>>(connection: Connection) {
  const key = getKey(connection.sessionId);
  const data = await api.redis.redis.get(key);
  if (!data) return null;
  await api.redis.redis.expire(key, config.session.ttl);
  return JSON.parse(data) as SessionData<T>;
}

/**
 * Create a new session in Redis for the given connection.
 *
 * @param connection - The connection to create a session for.
 * @param data - Initial session data. Defaults to `{}`.
 * @returns The newly created `SessionData` object.
 */
async function create<T extends Record<string, any>>(
  connection: Connection,
  data = {} as T,
) {
  const key = getKey(connection.sessionId);

  const sessionData: SessionData<T> = {
    id: connection.sessionId,
    cookieName: config.session.cookieName,
    createdAt: new Date().getTime(),
    data,
  };

  await api.redis.redis.set(key, JSON.stringify(sessionData));
  await api.redis.redis.expire(key, config.session.ttl);
  return sessionData;
}

/**
 * Merge new data into an existing session and persist to Redis. Refreshes the TTL.
 *
 * @param session - The existing session object to update.
 * @param data - Partial data to shallow-merge into `session.data`.
 * @returns The updated `session.data`.
 */
async function update<T extends Record<string, any>>(
  session: SessionData<T>,
  data: Record<string, any>,
) {
  const key = getKey(session.id);
  session.data = { ...session.data, ...data };
  await api.redis.redis.set(key, JSON.stringify(session));
  await api.redis.redis.expire(key, config.session.ttl);
  return session.data;
}

/**
 * Delete a session from Redis.
 *
 * @param connection - The connection whose session to destroy.
 * @returns `true` if a session was deleted, `false` if none existed.
 */
async function destroy(connection: Connection) {
  const key = getKey(connection.sessionId);
  const response = await api.redis.redis.del(key);
  return response > 0;
}

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<Session["initialize"]>>;
  }
}

export class Session extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["redis"];
  }

  async initialize() {
    return {
      load,
      create,
      update,
      destroy,
    };
  }
}
