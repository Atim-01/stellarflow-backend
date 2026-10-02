# Issue #789: Off-Chain Cache Invalidation Manager for Fast APIs

## Scope

Automatically purge stale Redis response caches the moment the underlying
off-chain data changes, so Fast API endpoints never serve data older than the
latest confirmed ledger or database write.

## Deliverables

- Purge stale Redis response caches automatically when new ledger events arrive.
- Listen to database modification triggers (Prisma query extension) and stream
  event publications (Redis `events:*` streams).
- Selectively purge route key patterns (e.g. `/api/v1/pools/123/*`) instead of
  flushing the entire cache keyspace.

## Acceptance Criteria

- New ledger events confirmed by the Soroban event listener purge market-rate,
  history, stats, intelligence, derived-asset and asset caches before the cache
  warming worker repopulates them.
- Cache-relevant database writes (OnChainPrice, PriceHistory, MultiSigPrice,
  MultiSigSignature, ProviderReputation, Currency, DerivedAsset, GovernanceVote)
  trigger targeted pattern purges.
- `events:cache-invalidation` stream publications and domain streams such as
  `events:pool-reserve-alerts` invalidate matching caches on every API instance.
- Route-scoped patterns like `/api/v1/pools/123/*` translate to cache-key globs
  and purge only the matching keys.
