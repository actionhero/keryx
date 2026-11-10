-- Compare-and-set one MCP task record, keeping its remaining TTL:
--   KEYS[1] = task key (mcp:task:{taskId})
--   ARGV[1] = the record exactly as the caller read it
--   ARGV[2] = the record to write
-- Returns 1 if written, 0 if the record changed (or expired) since it was read.
-- The caller re-reads and retries, so a status that went terminal in between —
-- a cancel racing a background run's result — is never overwritten.

local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
-- PTTL is -1 only for a key with no expiry. A key at its last millisecond
-- reads 0, and must keep an expiry rather than lose it.
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
  redis.call('SET', KEYS[1], ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[2], 'PX', math.max(ttl, 1))
end
return 1
