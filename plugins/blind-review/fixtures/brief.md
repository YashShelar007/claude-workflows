# Brief: add TTL expiry to MintCache

MintCache is a small LRU cache in `src/cache.js`. Add an optional `ttl`
constructor option, in **seconds**, after which `get` returns `undefined` and
evicts the entry. `ttl: 0` (the default) keeps today's behaviour.

Keep the recency bump in `get` (delete the key, then re-insert it) so LRU
ordering still works after a hit.

Done when a test proves a value is returned before the ttl elapses and
`undefined` after it.
