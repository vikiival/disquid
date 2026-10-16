# Ethereum token discovery squid

This squid discovers ERC-20 contracts that an account has sent or received through standard `Transfer` events on Ethereum mainnet. It indexes **all accounts**, starting at block **26,104,555**, through an Ethereum JSON-RPC endpoint with [`EvmRpcDataSourceBuilder`](https://github.com/subsquid/squid-sdk/blob/20cde9136b5d5871b06f2e834296ec320d3654a1/meta/squid-sdk/src/evm/rpc/builder.ts). It does not use an SQD Portal. PostgreSQL stores one row per account and token, and the bundled Subsquid GraphQL server serves discovery queries.

The source parser is separate from storage (`src/discovery.ts`), and the indexed account–token contract is separate from the Ethereum RPC source. Another network can add a parser and source while keeping the query shape; use a separate database or add a network key before indexing multiple chains in one database.

## Run

Use Node.js 20 or newer, pnpm, Docker, and an Ethereum mainnet RPC endpoint. Historical `eth_call` support is required only for `includeBalances: true` while the index is behind the head.

```sh
cp .env.example .env
# Set RPC_URL in .env
pnpm install
sqd up
sqd codegen
sqd build
sqd migration:apply
sqd process
```

In another terminal, run `sqd serve`. GraphiQL is at [http://localhost:4350/graphql](http://localhost:4350/graphql). `sqd run .` can launch the processor and API together after setup. The migration is a **fresh baseline**; use an empty database or schema rather than applying it over the original ERC-20 template tables. Do not remove the processor's status schema if you need to resume an existing index.

The root `justfile` provides shortcuts: `just run` prepares PostgreSQL, builds, applies migrations, and starts both services; `just process` and `just serve` start them separately. Use `just --list` for all recipes. `just down` stops PostgreSQL without deleting its container, which matters because this Compose setup has no persistent volume.

`RPC_URL` is used for ingestion and optional balance calls. `RPC_RATE_LIMIT`, `RPC_CAPACITY`, `RPC_STRIDE_SIZE`, and `RPC_STRIDE_CONCURRENCY` tune ingestion for the provider's quota. Lower concurrency or rate limit when the provider throttles. The checked-in `squid.yaml` declares `RPC_URL` as a deployment secret.

## GraphQL

```graphql
query Discover($account: String!, $withBalances: Boolean!) {
  discoveredTokens(account: $account, includeBalances: $withBalances, limit: 100, offset: 0) {
    indexedHeight
    tokens {
      address
      firstSeenBlock
      lastSeenBlock
      sentCount
      receivedCount
      balance
      balanceError
    }
  }
}
```

Variables:

```json
{"account":"0x0000000000000000000000000000000000000001","withBalances":false}
```

`account` is case insensitive. Tokens are ordered by latest observed interaction, then token address. `limit` is 1–100 and `offset` is 0–10,000. `indexedHeight` is the last block the processor committed; the index includes no data before block 26,104,555. Discovery is available even when `includeBalances` is false or balance RPC calls fail. `balance` is a decimal string in raw token units, read with Multicall3 at `indexedHeight`. A null `balance` with `balanceError` means that token call or the RPC read failed; a null `balance` without an error means balances were not requested. Pagination can shift as new interactions arrive, so clients needing a consistent full list should query after catching up and within a stable height.

The generated GraphQL schema also exposes `accountTokens(where: {account_eq: "0x..."})` and `indexerStateById(id: "eth-mainnet")` for direct indexed-data queries. The custom `discoveredTokens` query combines the rows, height, and optional balances in one response.

## Model and behavior

- `AccountToken` is keyed by lowercase `account:token` and indexed by account. It stores first and last observed block and sent/received event counts. Self-transfers increment both counts but create only one row.
- `IndexerState` stores the last fully processed block. The processor persists it in the same handler transaction as discovery rows, including batches without a matching Transfer.
- Logs must have the standard Transfer topic, exactly three topics, and 32 bytes of data. Four-topic ERC-721 Transfers are excluded. The emitting contract address is treated as the token address; token metadata and transfer history are not fetched.
- Subsquid's hot-block store handles rollback of unfinalized rows on detected forks. The GraphQL result may still change at the same height after a reorg.

## RPC cost and limits

This is a focused PoC, not a full indexer. Discovery does not scan an account's history on request; each query reads the account index in PostgreSQL. Optional balances make one Multicall3 `eth_call` per page of up to 100 tokens, with bounded RPC concurrency. At 5,000 balance queries per minute, the provider must sustain roughly 83 Multicall calls per second before retries, and PostgreSQL must sustain the associated reads. This target has **not been load tested**. If balances are usually requested and provider credits dominate cost, add block-hash-safe shared caching or cross-request batching before production rollout.

The current `@subsquid/squid-sdk@0.6.2` RPC source has a material ingestion cost: it fetches full transactions for every block and calls `eth_getLogs` by block range **without** pushing the Transfer topic into the RPC request. Filtering happens inside the SDK after fetch. See the released [RPC source](https://github.com/subsquid/squid-sdk/blob/20cde9136b5d5871b06f2e834296ec320d3654a1/meta/squid-sdk/src/evm/rpc/source/data-source.ts) and [RPC calls](https://github.com/subsquid/squid-sdk/blob/20cde9136b5d5871b06f2e834296ec320d3654a1/evm/evm-rpc/src/rpc.ts). Indexing the full range can be slow and expensive even though the persisted model is small. The SDK retries transient RPC failures and tracks finality/forks; persistent provider failures stop progress rather than serving a fabricated height. Monitor the indexed height and RPC usage during the initial catch-up.

This index misses holdings with no Transfer since the start block, native ETH, ERC-1155, and balance changes without a Transfer. Any contract can emit a three-topic Transfer-shaped event, so discovery is a heuristic rather than bytecode-level ERC-20 verification. The query has no spam filtering. Balance calls use the indexed block **number**, not a block hash; a reorg between the database read and RPC call can pair discovery and balance data from different blocks at the same height. Historical calls also need an archive-capable provider when the indexed height is old.

Run `npm test` for the parser and TypeScript build checks. The tests cover sender/recipient aggregation, self-transfers, and ERC-721/malformed-log exclusion.
