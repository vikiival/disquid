# Design: token discovery squid (RPC-only)

Reimplementation of `../i-see-u` (see `../i-see-u/ASSIGNMENT.md`) on the latest Subsquid SDK
(`@subsquid/squid-sdk` 0.6.2, `@subsquid/batch-processor` 1.1.0, `@subsquid/typeorm-store` 1.9.2,
`@subsquid/graphql-server` 4.12.1). Data comes **only from JSON-RPC** through
`EvmRpcDataSourceBuilder` (no SQD Portal). Ethereum mainnet from block **26,104,555**.

## Goals

- GraphQL: every ERC-20 token an account interacted with (sent or received a `Transfer`), optional
  current balances, and the block height (and hash) the answer is valid for.
- Near-realtime: follow the unfinalized head with reorg rollback (Subsquid hot blocks).
- RPC-efficient: every call costs credits (Quicknode ~20 credits per call).
- Tolerant of a bad RPC: slow, erroring, rate-limiting or lagging.
- 5k users polling once a minute (~83 req/s) on a single API process.
- Later: ERC-721 and ERC-1155 must slot in additively.
- Not a full indexer: no transfer history, one folded row per (account, token, standard).

## Layout

```
schema.graphql            entities (Token, AccountToken, Block); NFT entities sketched, not built
src/processor.ts          source configuration (builder + addLog for the enabled standards)
src/main.ts               run(source, TypeormDatabase({supportHotBlocks: true}), handler)
src/source/               RPC layer around EvmRpcDataSourceBuilder (cost, retries, reorg fix)
src/standards/            one module per token standard: topics + log decoder -> Interaction[]
src/discovery/            fold Interactions into AccountToken/Token rows, persist Block headers
src/server-extension/     custom GraphQL resolver(s) + on-demand balance service
test/                     vitest, *.test.ts
```

Each module reads its own env vars; there is no shared config file.

## Data model (schema.graphql)

- `Token { id = address, firstSeenBlock, name?, symbol?, decimals? }`: metadata reserved, nullable.
- `AccountToken { id = "<account>:<token>:<20|721|1155>", account, token -> Token, standard,
  firstSeenBlock, lastSeenBlock, sentCount, receivedCount }`, unique index
  `(account, standard, token)`. The main query is `WHERE account=$1 AND standard=$2 ORDER BY token_id`
  with keyset pagination on `token_id`, which gives stable pages while new activity arrives.
  Self-transfer: one row, both counters incremented.
- `Block { id = zero-padded number, number (unique), hash, timestamp }`: every processed header,
  written by the handler (requires `includeAllBlocks`), pruned to a retention window. Hot-block
  rollback removes orphaned rows, so the API can answer "is (R, hash) still canonical" and read
  the served head's hash in the **same snapshot** as the account rows.
- No `Account` entity: it would be one write per address for no query benefit.
- **Future NFTs** are additive: the same `AccountToken` rows with `standard = ERC721 | ERC1155`
  (contract-level discovery), plus `NftItem` (ERC-721 current owner, where the last `to` wins) and
  `AccountNftItem` (ERC-1155 ids seen per account; balances read via `balanceOfBatch` because the
  index starts mid-chain).

## Standards registry (src/standards)

```ts
export type Direction = 'in' | 'out'
export interface Interaction {
    account: string            // lowercase 0x address
    token: string              // lowercase contract address
    standard: TokenStandard    // from src/model
    direction: Direction
    block: number
    // reserved for NFTs: tokenId?: bigint; amount?: bigint
}
export interface StandardDecoder {
    standard: TokenStandard
    topic0: string[]           // pushed down to eth_getLogs and used in addLog
    decode(log: {address: string; topics: string[]; data: string}, block: number): Interaction[]
}
```

ERC-20 accepts only `Transfer` with exactly 3 topics and 32 bytes of data. It emits `out` for
`from` and `in` for `to`, and `0x0` mint/burn counterparties are skipped as accounts. ERC-721
(`Transfer`, 4 topics, same topic0) and ERC-1155 (`TransferSingle` / `TransferBatch`) are later
modules. `enabledDecoders()` builds the topic0 union that the processor passes to `addLog`.

## Processor (src/main.ts, src/discovery)

Per batch: decode every log with the registry and fold the results into a `Map<id, Pending>`.
Then:

1. Load the existing `Token`s for the batch's token ids (`findBy In`, chunks of 1000) and insert
   the missing ones. There is no cross-batch cache, because hot rollbacks would make it stale.
2. Load the existing `AccountToken`s by id (chunked), merge them (min first, max last, add counts)
   and `upsert`.
3. Upsert a `Block` row for every block in the batch. Prune rows older than
   `BLOCK_RETENTION` (default 50,000, about 7 days), at most once per N blocks.

Every write goes through `ctx.store`, never raw SQL: hot-block rollback only covers writes the
store records in its change log.

## RPC source (src/source)

The stock 0.6.2 RPC source has several problems (verified in the code):

1. It always fetches full transactions (`eth_getBlockByNumber(n, true)`).
2. `eth_getLogs` carries no topic/address filter, so the range must stay tiny.
3. The head is polled every 100 ms, which is not configurable.
4. `retryAttempts` defaults to 0 and there is no request timeout, so one 429 on `eth_getLogs` kills
   the processor.
5. **Reorg bug:** `ForkException` carries a single ref, so `findRollbackIndex` returns -1 and the
   processor throws "Unable to process fork" (crash-loop).

The fix is a `DiscoveryRpcSourceBuilder extends EvmRpcDataSourceBuilder` with the same fluent API
(`setRpc` / `setFields` / `addLog` / `includeAllBlocks` / `build`). Its `build()` assembles the
public classes itself:

- Its own `EvmRpcClient`: retries, request timeout, `maxBatchCallSize`, rate limit and capacity.
- `PushdownRpc extends Rpc`:
  - Header-only blocks.
  - `eth_getLogs` with the topic0 union (plus addresses when every request has them), split on
    "too large", time-outs and range-limit errors.
  - Every log's `blockHash` must match the header of its block. Otherwise it re-fetches by
    `blockHash`, and fails if they still disagree. No silent drops.
- `EvmRpcStreamDataSource` with configurable `headPollInterval`.
- Header-less finalized catch-up (`LogsCatchupDataSource`, on by default with the pushdown):
  - **Source:** below the finalized head, blocks come from `eth_getLogs` alone, in `maxLogsRange`
    ranges (100 by default). Number, hash and timestamp come from each log's `blockNumber`,
    `blockHash` and `blockTimestamp`.
  - **Headers, only when needed:** a header is fetched only for a block with no matching log
    (checked against the bloom), for logs without `blockTimestamp`, or for logs that disagree on
    the hash.
  - **Hand-off:** near the finalized head it hands over to the normal stream with the last hash as
    `parentHash`. The first block's real parent is checked first, so a hot head replaced during
    downtime still surfaces as a fork.
  - **Cost:** about 0.01 calls per block instead of 1.02. Measured on 2,000 blocks: identical
    hashes, timestamps and logs; 20 calls instead of 2,041.
- A fork-safe wrapper that rethrows `ForkException` with the new chain's ancestry, walked by
  parent hash down to the finalized head.
- RPC call counters by method, logged periodically.

Client-side filtering stays authoritative; the pushdown only has to return a superset.

## API (src/server-extension)

The custom type-graphql query sits next to the generated CRUD (`accountTokens`, `tokens`,
`blocks`, `squidStatus`):

```graphql
tokenDiscovery(account: String!, standard: TokenStandard = ERC20, includeBalances: Boolean = false,
               first: Int = 100, after: String): TokenDiscoveryResult!
TokenDiscoveryResult { account, standard, blockHeight, blockHash, blockTimestamp,
                       tokens: [DiscoveredToken!]!, nextCursor, balancesComplete }
DiscoveredToken { token (address), symbol?, decimals?, firstSeenBlock, lastSeenBlock,
                  sentCount, receivedCount, balance?, balanceBlock?, balanceError? }
```

- **Consistency:** one REPEATABLE READ transaction reads the head `Block` (number, hash, time) and
  the account's rows, so the rows are exactly the state at `blockHeight`.
- **Balances:**
  - Multicall3 `aggregate3` (`allowFailure`) of `balanceOf`, pinned to the served block **hash**
    (EIP-1898).
  - Cross-request coalescing: pairs at the same block hash join one open batch, flushed at N pairs
    or after a short window.
  - A bounded queue: when it is full, the affected tokens get `balanceError: RPC_BUSY`, not a failed
    query.
- **Change-driven cache** (in memory, per process): `(account, token) -> {value, block R, hash}`.
  An entry is reused at served block S when all of these hold:
  - `lastSeenBlock <= R`;
  - `Block[R].hash == hash` in the same snapshot;
  - the token is not in the always-refresh list (WETH, stETH, ... whose balances change without a
    Transfer);
  - the entry is younger than `BALANCE_CACHE_MAX_AGE` (this bounds staleness from non-Transfer
    changes).
- A per-token RPC failure never fails discovery.

## Multi-network

One squid deployment (database schema) per network. Chain specifics live in a network entry
(start block, RPC preset slug, Multicall3 address, always-refresh tokens). Non-EVM chains would
implement their own source plus decoders that emit the same `Interaction`s.
