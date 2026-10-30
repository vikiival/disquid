# Envio HyperIndex port of disquid

This directory ports the token-discovery squid to [Envio HyperIndex](https://docs.envio.dev). It keeps the squid's
`Token`, `AccountToken` and `NftItem` entities, with the same fields and ids, and indexes the same Ethereum mainnet
`Transfer` events from block 26,104,555. Logs come from HyperSync, so ingestion needs no `eth_getLogs` calls and no
custom RPC source. Token name, symbol and decimals are still read over JSON-RPC, as in the squid.

The squid is untouched. The port sits beside it, with its own `pnpm` project, so you can run both and compare.

## Run it

You need Node.js 22.15 or later, pnpm 10, Docker (for `pnpm dev`) and a free Envio API token for HyperSync
(<https://envio.dev/app/api-tokens>).

```bash
cd envio
pnpm install
cp .env.example .env     # set ENVIO_API_TOKEN
pnpm dev                 # starts Postgres and Hasura in Docker, then indexes
```

Hasura serves GraphQL at <http://localhost:8080> (local admin password `testing`). To stop at a fixed block, set
`ENVIO_END_BLOCK`. To use your own Postgres, set `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`,
`ENVIO_PG_PASSWORD` and `ENVIO_PG_DATABASE` (and `ENVIO_HASURA=false` to skip Hasura), then `pnpm start -r`
(`-r` wipes the database and re-indexes).

```bash
pnpm codegen      # after editing config.yaml or schema.graphql
pnpm typecheck
pnpm test         # vitest: interaction rules, owner rules, metadata decoding
```

### RPC (token metadata only)

When a token is first seen, its `name()`, `symbol()` and `decimals()` are read at `latest` through Multicall3:
one `eth_call` per up-to-50 tokens, as in the squid. The reads go through the Effect API, so concurrent requests in a
batch are folded together and results are cached in the database. No archive node is needed. Set `ENVIO_RPC_URL`
(comma-separated for fallbacks) to use your own endpoint; it defaults to public endpoints. A transport error is retried
with backoff, and after eight failures the indexer stops rather than store a token with missing metadata.

## What maps to what

| Squid | HyperIndex |
| --- | --- |
| ERC-20 decoder: `Transfer` with 3 topics, 32-byte data | `ERC20` contract, wildcard `Transfer(address indexed from, address indexed to, uint256 value)` |
| ERC-721 decoder: `Transfer` with 4 topics, empty data | `ERC721` contract, wildcard `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` |
| `src/standards/*`, `src/discovery/aggregate.ts` | `src/lib/standards.ts`, `src/handlers/discovery.ts` |
| `src/metadata/*` (Multicall3 name/symbol/decimals) | `src/lib/metadata.ts`, `src/lib/decode.ts` (Effect) |
| `Token`, `AccountToken`, `NftItem` | same names, fields and ids (`account:token:20\|721`, `contract:tokenId`) |

Behaviour kept from the squid: the zero address is not an account (mint or burn), zero-value ERC-20 transfers are
skipped, a self-transfer increments both counters on one row, `NftItem.owner` is the last `to` (the zero address after
a burn), and a contract that emits both shapes gets one `Token` and one `AccountToken` per standard.

## Differences a consumer will notice

- **No `Block` entity.** The squid stores recent block headers (pruned to 50,000 blocks) to make its own API
  reorg-safe. HyperIndex handles reorgs itself, so the port does not store them.
- **No custom API.** The squid's `discoveredTokens` / `tokenDiscovery` query, with on-demand Multicall3 balances and
  its balance cache, is not ported. HyperIndex exposes the three entities through its generated GraphQL (Hasura), so
  queries are filters such as `AccountToken(where: {account: {_eq: "0x..."}, standard: {_eq: ERC20}})`. Balances
  would have to be a separate service.
- **Column names** follow HyperIndex: `token_id` is the foreign key, fields are camelCase (`firstSeenBlock`).
  `metadataStatus` exists but is always `FETCHED`: failed metadata reads stop the indexer instead of leaving the token
  `PENDING`, and there is no background sweep.
- **Malformed Transfer layouts.** The squid rejects a log whose indexed address topics have non-zero high bytes, or
  whose ERC-20 data is not exactly 32 bytes. HyperIndex decodes what the ABI allows. No difference showed up in the
  parity run below, but it is a possible source of rare differences on a longer range.
- **ERC-1155** is not indexed, as in the squid.

## Benchmark

Range 26,104,555 to 26,114,694 (10,140 blocks, 5,882,567 events), from an empty database, on one laptop that other
processes were also using, so timings are noisy. Public endpoints, no paid keys.

| | HyperIndex 3.15.0 | squid (`95851d9`) |
| --- | --- | --- |
| Data source | HyperSync | `eth.drpc.org`, with the settings in the squid's `.env.example` (`RPC_RATE_LIMIT=10`, `RPC_CAPACITY=10`, `RPC_STRIDE_SIZE=20`, `RPC_STRIDE_CONCURRENCY=1`) |
| Time | 292 s | about 660 s |
| Log requests to a node | 0 | 799 JSON-RPC calls in total; `eth_getLogs` ranges split on the endpoint's 20,000-result cap |

The HyperIndex time runs from "Starting indexing" to "Indexed to the end block" in the log. A first run on a
10,000-block range, with less load on the machine, took 203 s. The squid's time runs from its first batch log to the
last one before it was stopped at block 26,114,694. The squid ran at the same time as a longer HyperIndex run on the
same machine. HyperIndex also read metadata for about 17,000 tokens over public RPC endpoints (the defaults in
`src/lib/metadata.ts`). The squid does the same on its own client; those calls are not in its 799. The squid's endpoint rate-limited it
(38 HTTP 429 responses in its log), so part of the gap is the public RPC; a paid RPC would shift the squid's number, and
we did not try one.

`eth-mainnet.public.blastapi.io` could not be used for the squid: it rejected log ranges above 10 blocks.

## Parity

After both finished at block 26,114,694, every row of the three tables was compared field by field:

| Table | Rows | Differences |
| --- | --- | --- |
| `AccountToken` (ids, account, token, standard, first/last seen block, sent and received counts) | 3,037,586 | 0 |
| `Token` (first seen block, name, symbol, decimals, status) | 17,160 | 0 |
| `NftItem` (id, contract, token id, owner, last transfer block) | 73,982 | 0 |

## Full range

Not run to head. A run from block 26,104,555 with no end block was stopped by hand at block 26,155,200 (50,645
blocks, 25,791,799 events, 4.7 GB of Postgres) after about 22 minutes of indexing, because the laptop's disk was
nearly full. That is about 38 blocks/s on average, falling from about 49 blocks/s over the first 10,000 blocks to about
27 blocks/s as the tables grew. The chain head was about 26.30M, so a full run was not measured. The squid's own
`BENCHMARK.md` puts the range at roughly 530 Transfers per block; here it was about 510–580.

## Layout

```
config.yaml                 chain 1, start block 26104555, two wildcard contracts
schema.graphql              Token, AccountToken, NftItem
src/handlers/discovery.ts   Transfer handlers (ERC-20 and ERC-721)
src/lib/standards.ts        who sent and received; NFT owner rule; ids
src/lib/metadata.ts         Effect: batched Multicall3 name/symbol/decimals
src/lib/decode.ts           label and decimals decoding (from the squid)
test/discovery.test.ts      vitest
pnpm-workspace.yaml         makes envio/ its own pnpm root (the squid has a workspace file one level up)
vitest.config.ts            keeps vitest from picking up the squid's config
```
