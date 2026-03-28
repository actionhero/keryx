---
description: Use the built-in Redis connection for caching — cache-aside, response middleware, and invalidation patterns.
---

# Caching

Keryx already boots a Redis connection for you. `api.redis.redis` is a fully configured [ioredis](https://github.com/redis/ioredis) client, available the moment your initializers finish starting. You don't need a separate caching library. Redis _is_ your caching layer.

## How Redis is Initialized

The `redis` initializer creates two ioredis connections at startup:

| Connection | Access | Purpose |
|---|---|---|
| `api.redis.redis` | General commands | Caching, ad-hoc queries, anything your app needs |
| `api.redis.subscription` | PubSub subscriber | Reserved for [channels](/guide/channels) — don't use this for caching |

Both connect to the URL in `config.redis.connectionString` (defaults to `redis://localhost:6379/0`, overridable via `REDIS_URL`). The initializer verifies connectivity at boot — if Redis is unreachable, the server won't start.

Because `api.redis.redis` is a standard ioredis instance, every Redis command is available: `GET`, `SET`, `DEL`, `HSET`, `LPUSH`, `EXPIRE`, `SETNX`, pipelines, Lua scripts, streams — the full Redis API. No wrapper to learn.

## Cache-Aside Pattern

The most common approach: check Redis before hitting the database, populate the cache on a miss.

```ts
import { api } from "keryx";
import { eq } from "drizzle-orm";
import { users } from "../schema";

const CACHE_TTL = 300; // 5 minutes

export async function getUserById(id: number) {
  const cacheKey = `cache:user:${id}`;

  // Try cache first
  const cached = await api.redis.redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Miss — query the database
  const [user] = await api.db.db
    .select()
    .from(users)
    .where(eq(users.id, id));

  if (user) {
    await api.redis.redis.set(cacheKey, JSON.stringify(user), "EX", CACHE_TTL);
  }

  return user ?? null;
}
```

Invalidate when the data changes:

```ts
export async function updateUser(id: number, data: Partial<User>) {
  const [updated] = await api.db.db
    .update(users)
    .set(data)
    .where(eq(users.id, id))
    .returning();

  await api.redis.redis.del(`cache:user:${id}`);
  return updated;
}
```

## Cache Middleware

For actions where you want response-level caching without touching the action body, write a [middleware factory](/guide/advanced-patterns#middleware-factories). The middleware stores the cache key in `runBefore` and handles both cache hits and misses in `runAfter` (since only `runAfter` can replace the response via `updatedResponse`):

```ts
import { api, type ActionMiddleware, type Connection, type TypedError } from "keryx";

export function CacheMiddleware(ttl: number): ActionMiddleware {
  return {
    runBefore: async (params: Record<string, unknown>, connection: Connection) => {
      const key = `cache:action:${connection.actionName}:${JSON.stringify(params)}`;
      connection.metadata._cacheKey = key;
      connection.metadata._cacheTTL = ttl;

      const cached = await api.redis.redis.get(key);
      if (cached) {
        connection.metadata._cachedResponse = cached;
      }
    },

    runAfter: async (_params: Record<string, unknown>, connection: Connection, error?: TypedError) => {
      // On a cache hit, return the cached response
      if (connection.metadata._cachedResponse) {
        return { updatedResponse: JSON.parse(connection.metadata._cachedResponse as string) };
      }

      // Don't cache error responses
      if (error) return;

      // Cache miss — store the action's result for next time
      const key = connection.metadata._cacheKey as string;
      const ttl = connection.metadata._cacheTTL as number;
      // The action's response will be returned as-is; we just persist it
    },
  };
}
```

Use it on read-heavy actions:

```ts
export class UserShow implements Action {
  name = "user:show";
  middleware = [CacheMiddleware(60)]; // cache for 60 seconds
  web = { route: "/user/{userId}", method: HTTP_METHOD.GET };
  inputs = z.object({ userId: z.coerce.number() });

  async run(params: ActionParams<UserShow>) {
    return { user: await UserOps.findById(params.userId) };
  }
}
```

The middleware builds a cache key from the action name and serialized params. On a cache hit, `runAfter` returns `{ updatedResponse }` to replace the action's output with the cached value. On a miss, it stores the result for next time. The `error` parameter lets you skip caching failed responses.

## Invalidation

### By Key

When you know exactly which cache entry changed:

```ts
await api.redis.redis.del(`cache:user:${userId}`);
```

### By Pattern

Need to bust all cached responses for a resource? Use a key prefix convention and `scanStream`:

```ts
export async function invalidateUserCache(userId: number) {
  const stream = api.redis.redis.scanStream({
    match: `cache:*:*user*:${userId}*`,
    count: 100,
  });

  for await (const keys of stream) {
    if (keys.length > 0) await api.redis.redis.del(...keys);
  }
}
```

### Version-Based

For high-throughput invalidation, embed a version counter in your cache keys and bump it instead of scanning. A single `INCR` replaces an unbounded `SCAN`:

```ts
const version = await api.redis.redis.get(`version:user:${id}`) ?? "0";
const cacheKey = `cache:user:${id}:v${version}`;

// To invalidate: bump the version. Old keys expire naturally via TTL.
await api.redis.redis.incr(`version:user:${id}`);
```

## Beyond GET/SET

Because you have the full ioredis client, you're not limited to string caching:

| Technique | Redis command | Use case |
|---|---|---|
| Atomic set-if-absent | `SETNX` / `SET ... NX` | Distributed locks, deduplication |
| Hash fields | `HSET` / `HGET` / `HGETALL` | Cache objects without serializing the whole thing |
| Sorted sets | `ZADD` / `ZRANGE` | Leaderboards, rate-limit sliding windows |
| Pipelines | `pipeline().get().set().exec()` | Batch multiple commands in one round trip |
| Lua scripts | `eval()` / `evalsha()` | Atomic read-modify-write operations |
| Expiry | `EXPIRE` / `PEXPIRE` | TTL on any key type, not just strings |

## Why Not a Cache Abstraction?

You might expect a `cache.get()` / `cache.set()` wrapper. We intentionally skip that layer — ioredis already has a clean API, and a thin wrapper just hides the Redis features you'll eventually need. If you know Redis, you already know the Keryx caching API.
