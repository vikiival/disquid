# Spike: SQD RPC source fetches header-only blocks and topic-filtered `eth_getLogs`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, fill in the "Results" section at the
> end of this file.
>
> **Where the work happens**: in the sibling repo
> `/Users/vikival/Documents/Work/Playground/disquid` (called **disquid**
> below). This is speculative and not part of i-see-u
> (`/Users/vikival/Documents/Work/Playground/i-see-u`); do not change anything
> there. i-see-u files are cited only as reference implementations.
>
> **Secrets**: `disquid/.env` holds `RPC_URL`, a Quicknode URL with the API
> key in its path. Never print it, never commit `.env`, and never put it in a
> file under `out/` or in this plan. Read it only through `process.env`.
>
> **Drift check (run first)**:
> ```bash
> cd /Users/vikival/Documents/Work/Playground/disquid
> git log --oneline -1            # expect 207fd0b
> git status --short              # expect: M .env, M package.json, M src/main.ts, M src/processor.ts, ?? pnpm-workspace.yaml
> # .env is tracked (template default) and holds the real RPC_URL locally: never stage it
> pnpm ls @subsquid/evm-rpc @subsquid/squid-sdk @subsquid/evm-normalization @subsquid/batch-processor
> # expect evm-rpc 0.2.0, squid-sdk 0.6.2, evm-normalization 0.1.0, batch-processor 1.1.0
> ```
> Any other version is a STOP condition: every excerpt below is from those
> exact versions.

## Status

- **Priority**: speculative (i-see-u does not depend on it)
- **Effort**: M (about 150 lines of patch, plus a proxy script and three measured runs)
- **Risk**: MED (patches third-party GPL code; live RPC calls cost credits)
- **Depends on**: none
- **Category**: research spike / RPC credits
- **Planned at**: disquid `207fd0b` plus an uncommitted RPC-only prototype, 2026-10-15
- **Executor**: Codex (`codex exec`), with an Opus or gpt-6-astra review of the patch before Step 9

## Why this matters

i-see-u is a TypeScript PoC that indexes every ERC-20/721 `Transfer` log on Ethereum from block 25,933,634 into Postgres, over plain JSON-RPC (Quicknode, **billed per call**, about 20 credits each, 80M credits/month plan). Its finalized follower costs, per block range, one header-only `eth_getBlockByNumber(n, false)` per block plus one `eth_getLogs({fromBlock, toBlock, topics: [Transfer]})` per 500 blocks.

Viktor found that the new Squid SDK (`@subsquid/squid-sdk` 0.6.2, `EvmRpcDataSourceBuilder`) can run on RPC alone, without the SQD Portal, and built a stub in disquid. A source-level review (i-see-u `PROGRESS.md` §16) found three cost problems that cannot be fixed by configuration:

1. **Full blocks.** Every block is fetched with full transaction objects (`eth_getBlockByNumber(n, true)`): hundreds of transactions, roughly 100–300 KB per mainnet block, even when only logs are wanted.
2. **Unfiltered logs.** `eth_getLogs` is sent with only `fromBlock`/`toBlock`; every log of the range comes back and is filtered client-side. Because an unfiltered mainnet range explodes quickly, the range is kept to one stride (default 5 blocks), so a 265k-block window costs about 53k `eth_getLogs` calls instead of about 530.
3. **100 ms head polling.** Once caught up, the source asks for `latest` every 100 ms (`headPollInterval`, not exposed by the squid-sdk builder). That is about 864k calls a day, about 17M credits a day, which by itself would blow the monthly plan in under five days.

There is also a **correctness gap** that matters once the logs-bloom check is off: `addLogs` groups logs by `blockHash` and silently drops logs whose hash matches no header in the batch. Behind a load-balanced provider (i-see-u `PROGRESS.md` §13: Quicknode answers from different nodes, `x-node-id` varies), a by-number `eth_getLogs` can return another fork's logs; the block then looks empty and nobody notices. i-see-u's follower rejects such responses; the patch must too.

After this plan:
- An opt-in `logFilterPushdown: true` on `setRpc(...)` makes the RPC source fetch **header-only** blocks when no transaction data is needed, send the union of the requested `topic0` (and addresses, when every log request has them) **to the node** in `eth_getLogs`, **split** ranges the provider rejects as too large, and **re-fetch by block hash** any block whose logs do not match its header.
- `headPollInterval` is exposed on `setRpc(...)`.
- Client-side filtering stays exactly as it is, so the server-side filter only has to be a **superset**; output is unchanged.
- We have measured numbers (calls by method, response bytes, wall time) for unpatched vs patched over the same 1,000 blocks, plus a parity check of the decoded Transfers, plus a 10-minute head-mode sample.

What it does **not** do: adopt SQD in i-see-u, change i-see-u code, upstream the patch, or touch traces/state diffs/receipts paths (they keep fetching full transactions).

## Current state (verified excerpts)

Paths below are relative to `disquid/node_modules/@subsquid/`. Each package ships `src/*.ts` (reference) and `lib/*.js` (CommonJS, **what actually runs**) plus `lib/*.d.ts`. pnpm stores them under `node_modules/.pnpm/...`; the `@subsquid/*` entries are symlinks.

### disquid prototype

`disquid/src/processor.ts` (uncommitted):
```ts
export const source = new EvmRpcDataSourceBuilder()
    .setRpc({
        url: process.env.RPC_URL!,
        network: 'ethereum-mainnet',
    })
    .setFields({
        block: { timestamp: true },
        log: { address: true, topics: true, data: true, transactionHash: true },
    })
    .addLog({
        where: { address: [USDC], topic0: [erc20.events.Transfer.topic] },
        range: { from: 6_082_465 },
    })
    .build()
```
`disquid/src/main.ts` calls `run(source, new TypeormDatabase({supportHotBlocks: true}), handler)` from `@subsquid/batch-processor`; the handler `console.log`s every log.

### squid-sdk: full transactions are forced

`squid-sdk/src/evm/rpc/source/data-source.ts`, `EvmRpcStreamDataSource` constructor (compiled: `squid-sdk/lib/evm/rpc/source/data-source.js:46`):
```ts
        let coarse = unionRequiredData(this.flatRequests.map((r) => r.request), options.fields)
        this.withTraces = coarse.traces
        this.withStateDiffs = coarse.stateDiffs

        let req: RpcDataRequest = {
            // Always fetch full transaction objects: mapRpcBlock maps the block's transactions
            // unconditionally (and traces/stateDiffs are correlated to them), so a hashes-only
            // block fetch can't be normalized. ...
            transactions: true,
            logs: coarse.logs,
            receipts: coarse.receipts,
            traces: coarse.traces,
            stateDiffs: coarse.stateDiffs,
            useTraceApi: options.method?.useTraceApi,
            ...
        }

        this.inner = new EvmRpcDataSource({
            rpc: options.rpc,
            req,
            strideSize: options.strideSize,
            strideConcurrency: options.strideConcurrency,
        })
```
`mapBlock(raw)` in the same file runs `mapRpcBlock(raw, ...)` → `decodeBlock(normalized, augmentedFields)` → `filterBlock(filtered, flat, setUpRelations(filtered))`. **That client-side filter stays authoritative after the patch.**

### squid-sdk: request flattening

`squid-sdk/src/evm/rpc/filter/request.ts`:
- `FlatLogRequest { address?: string[]; topic0?..topic3?: string[]; transaction?; transactionTraces?; transactionLogs?; transactionStateDiffs? }`
- `FlatDataRequest { includeAllBlocks?; logs?: FlatLogRequest[]; transactions?: FlatTransactionRequest[] (has .logs?); traces?: FlatTraceRequest[] (has .transactionLogs?); stateDiffs? }`
- `toRequiredData(req, fields)` / `unionRequiredData(requests, fields)` return `{logs, receipts, traces, stateDiffs}`; `logs &&= !receipts`.
- Non-exported helpers: `transactionsRequested(req)` (true if `req.transactions?.length` or any log/trace/stateDiff item has `transaction: true`), `logsRequested(req)` (true if `req.logs?.length`, any `transactions[].logs`, or any `traces[].transactionLogs`).

### squid-sdk: builder and network presets

`squid-sdk/src/evm/rpc/builder.ts`:
```ts
export interface EvmRpcOptions {
    url: string
    network?: EvmNetwork
    rpc?: NetworkOverrides['rpc']
    method?: RpcMethodOptions
    capacity?: number
    rateLimit?: number
    strideSize?: number
    strideConcurrency?: number
}

export function evmRpcStream<F extends FieldSelection>(config: EvmRpcStreamConfig<F>): EvmRpcStreamDataSource<F> {
    const settings = resolveNetworkSettings(config.network, {rpc: config.rpc, method: config.method})
    warnIfParityUnverified(config)
    const client = new EvmRpcClient({ url: config.url, capacity: config.capacity, rateLimit: config.rateLimit })
    const rpc = new Rpc({client, ...settings.rpc})
    return new EvmRpcStreamDataSource<F>({
        rpc, fields: config.fields, requests: config.requests, method: settings.method,
        strideSize: config.strideSize, strideConcurrency: config.strideConcurrency,
    })
}
```
`EvmRpcDataSourceBuilder.setRpc(options: string | EvmRpcOptions)` stores the options; `build()` calls `evmRpcStream({...this.options, fields, requests: this.getRequests()})`.

`squid-sdk/src/evm/rpc/networks/index.ts` `resolveNetworkSettings` returns `{rpc: {...preset?.rpc, ...overrides?.rpc}, method: {...}}`. The Ethereum preset (`networks/ethereum-mainnet.ts`) is `standardValidation` from `networks/_families.ts`:
```ts
export const standardValidation: RpcValidationOptions = {
    verifyBlockHash: true, verifyTxSender: true, verifyTxRoot: true,
    verifyReceiptsRoot: true, verifyLogsBloom: true, callFrameValidation: 'observe',
}
```

### evm-rpc: data request, block batch, logs

`evm-rpc/src/types.ts`:
```ts
export interface DataRequest {
    transactions?: boolean
    logs?: boolean
    receipts?: boolean
    traces?: boolean
    stateDiffs?: boolean
    useDebugApiForStateDiffs?: boolean
    useDebugTraceBlockByNumber?: boolean
    useTraceApi?: boolean
    debugTraceTimeout?: string
}
export interface Block { number: number; hash: Bytes32; block: GetBlock; logs?: Log[]; ...; _isInvalid?: boolean; _errorMessage?: string }
```

`evm-rpc/src/rpc.ts` (compiled `evm-rpc/lib/rpc.js`; `eth_getLogs` at about line 201):
- `getBlockBatch(numbers, req)` (about line 170): `withTransactions = req?.transactions ?? false` (plus a call-frame case that only applies to traces) → `getBlocks(numbers, withTransactions)` → truncates the chain at the first null block or parent-hash break → `addRequestedData(chain, req)`. **Header-only fetch is already supported here**; only squid-sdk forces `true`.
- `getBlocks` (about line 202) sends one JSON-RPC batch of `eth_getBlockByNumber [toQty(n), withTransactions]` through `reduceBatchOnRetry` (halves the batch on connection-type errors).
- `mapBlock` (about line 236): `verifyBlockHash` uses header fields only (works header-only); `verifyTxRoot` and `verifyTxSender` are guarded by `&& withTransactions` (skipped header-only).
- `addRequestedData(blocks, req)` (about line 293): `if (req?.logs) subtasks.push(this.addLogs(blocks))`.
- `addLogs(blocks)` (about line 301):
```ts
    private async addLogs(blocks: Block[]) {
        if (blocks.length == 0) return

        let results = await this.call('eth_getLogs', [{
            fromBlock: blocks[0].block.number,
            toBlock: last(blocks).block.number
        }], {
            validateResult: getResultValidator(array(Log)),
            validateError: info => {
                if (info.message.includes('after last accepted block')) {
                    return []   // Avalanche
                }
                throw new RpcError(info)
            }
        })

        let utils = await this.getChainUtils()
        let logsByBlock = groupBy(results, log => log.blockHash)
        for (let i = 0; i < blocks.length; i++) {
            let block = blocks[i]
            let logs = logsByBlock.get(block.hash) || []        // <- foreign-hash logs silently dropped
            if (utils.isStable) this.fixLogIndexes(logs)        // Stable chain only, irrelevant here
            try {
                if (this.checkLogIndex) { /* asserts logIndex 0,1,2,... contiguous */ }
                if (this.verifyLogsBloom) {
                    let logsBloom = utils.calculateLogsBloom(block.block, logs)
                    assert.equal(block.block.logsBloom, logsBloom, 'failed to verify logs bloom')
                }
            } catch (err: any) { throw addErrorContext(err, {...}) }
            block.logs = logs
        }
    }
```
`fromBlock`/`toBlock` are the blocks' own `number` fields (hex quantities).

### evm-rpc: streaming

- `evm-rpc/src/data-source/rpc-data-source.ts`: `EvmRpcDataSourceOptions { rpc; req; strideSize? (default 5); strideConcurrency? (default min(5, client concurrency)); headPollInterval? (default 100 ms) }`. `ensureContinuity` checks `parentHash` continuity across batches and throws `ForkException`; this is what the hot-block store rolls back on. **No change needed.**
- `data-source/ingest.ts`: below the finalized head it splits `[beg, finalizedTop]` into `strideSize` ranges and runs `getBlocks(rpc, req, range)` for each, `strideConcurrency` at a time; near the head it uses `PollStream`, and when a poll returns no blocks it does `await wait(headPollInterval)` and polls again. Each poll that finds itself at the head calls `getLatestBlockhash('latest')` (one `eth_getBlockByNumber('latest', false)`). The finalized head is refreshed through a `Throttler` every 5 s.
- `data-source/get-blocks.ts` `getBlocks`: re-requests blocks that came back `null` or `_isInvalid` (up to 5 retries, 100 ms apart), then throws with `_errorMessage`.
- `data-source/poll-stream.ts`: `makePlan` takes up to `strideSize + 1` blocks; `fetchBlocks` truncates at the first `_isInvalid` block.

### evm-normalization: full transactions asserted

`evm-normalization/src/mapping.ts:702-721` (compiled `evm-normalization/lib/mapping.js`, search for `typeof tx !== 'string'`):
```ts
export function mapRpcBlock(src: rpc.Block, options?: MappingOptions): Block {
    let block: Block = { header: mapBlockHeader(src.block), transactions: [], logs: [], ... }
    let txIndex = new Map()
    for (let i = 0; i < src.block.transactions.length; i++) {
        let tx = src.block.transactions[i] as rpc.Transaction
        assert(typeof tx !== 'string')
        ...
        block.transactions.push(mapTransaction(tx, receipt))
    }
    if (src.logs) { for (...) block.logs.push(mapLog(log)) }
    ...
```
`mapBlockHeader` reads only header fields (`transactionsRoot`, not the transaction list). The `GetBlock` validator (`evm-rpc/src/rpc-data.ts:646`) accepts `transactions` as either hashes or objects (`oneOf`).

### i-see-u reference implementation (do not edit; copy the ideas)

- `i-see-u/src/chains/evm/logs.ts:159-205` `scanLogs`: on a `too_large` error, or a timeout on a multi-block range, split the range (at the provider's suggested range if given, else in half) and recurse; a single block never splits.
- `i-see-u/src/rpc/errors.ts:40-54` classifies `too_large`: HTTP 413, or a message matching
  `/query returned more than \d+ results|ranges? over \d+ blocks? (?:are|is) not supported|max range\s*:|block range too large|response size exceeded/`
  (applied to the lower-cased message), and `errors.ts:28` parses a suggested range from `block range [0x.., 0x..]`.
- `i-see-u/src/chains/evm/logs.ts:88-94`: tail fetches logs **by block hash**: `eth_getLogs({blockHash, topics: [TRANSFER_TOPIC]})` (EIP-234, verified on Quicknode in i-see-u `PROGRESS.md` §13).
- `TRANSFER_TOPIC` = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.

## Design

**Opt-in, superset, authoritative client filter.** `logFilterPushdown` defaults to `false`; with it off, every patched function behaves exactly as before (same calls, same params). With it on, the node-side filter is the union of what all requests could match, and `filterBlock` still runs, so the output can only lose data if the node-side filter is *narrower* than the client filter. The derivation rules below are written so that can't happen: when in doubt, return `undefined` (no node-side filter).

**Header-only rule.** Fetch with `transactions: false` only when `logFilterPushdown` is on **and** none of these hold:
- any flat request `transactionsRequested(...)` (a `transactions` request, or `transaction: true` on a log/trace/stateDiff item),
- `coarse.receipts || coarse.traces || coarse.stateDiffs`,
- any field selected in `fields.transaction` (`Object.values(fields.transaction ?? {}).some(Boolean)`).

Otherwise keep `transactions: true` (current behaviour).

**Logs filter rule** (`logsPushdownFilter(requests)`). Return `undefined` unless logs are needed and every request that needs logs needs them only through `logs[]` items:
- For each flat request: if any `transactions[].logs` or any `traces[].transactionLogs` → return `undefined` (those need *all* logs of a transaction).
- Collect every `logs[]` item across all requests. If there are none → `undefined`.
- If any item has no `topic0` or an empty `topic0` → `undefined`.
- `topics = [unique lower-cased union of all topic0]`. Do not push `topic1..3` (keeps the superset trivially correct).
- `address`: if **every** item has a non-empty `address` → unique lower-cased union; else omit the field. If the union exceeds 1,000 addresses, omit it (provider limits; the topic filter already does the heavy lifting).

Ranges are ignored (the union over all ranges is a superset for each block).

**Log/header membership.** With a filter, after each range fetch every returned log must have `blockNumber` inside the fetched block numbers, `removed !== true`, and `blockHash` equal to that block's header hash. For each block that fails (or that received a log with a foreign hash for its number), re-fetch its logs **by hash**: `eth_getLogs({blockHash, topics, address?})`. If that call errors with an unknown block (the header itself is from a stale fork), set `block._isInvalid = true` and `block._errorMessage = ...`, so `getBlocks` re-requests that block (header and logs) through its existing retry loop. Never silently drop.

**Splitting.** With a filter, `eth_getLogs` over `[from, to]` splits on too-large (classifier above) or on a timeout when `from < to`; a one-block range rethrows. Use the provider's suggested range when it starts at `from` and ends before `to`. Without a filter, keep the single upstream call.

**Validation trade-off.** The logs bloom check needs every log of the block, so it cannot run against filtered logs; `checkLogIndex` expects contiguous indexes from 0, which filtered logs aren't. The builder **throws** at build time if `logFilterPushdown` is on while the resolved `verifyLogsBloom` or `checkLogIndex` is true, with a message naming the `rpc: {verifyLogsBloom: false, checkLogIndex: false}` override. This keeps the trade-off visible in the user's config rather than silently disabled. `verifyBlockHash` stays on (it works on headers). `verifyTxRoot`/`verifyTxSender` are already skipped when the fetch is header-only. What we lose is exactly what i-see-u already lacks: detection of silently omitted logs.

**Head polling.** Pass `headPollInterval` from `EvmRpcOptions` through `EvmRpcStreamOptions` to `EvmRpcDataSource`. disquid sets 3,000 ms (Ethereum slots are 12 s; i-see-u's tail sees new blocks 2.0–3.8 s after their timestamp).

## Implementation steps

### Step 1: Baseline the disquid repo

1. `cd /Users/vikival/Documents/Work/Playground/disquid`.
2. `.env` **is tracked** in disquid (the SQD template commits a default `.env`; `.gitignore` does not list it) and is modified locally with the real `RPC_URL`. So: never `git add .env`, `git add -A`, `git add .` or `git commit -a` in this plan; always stage explicit paths. Run `git update-index --skip-worktree .env` so it stops showing as modified and cannot be staged by accident (undo with `--no-skip-worktree` at the end; record that you did it). Add `/out` to `.gitignore` (and a trailing newline: the last line `**/*.log` currently has none).
3. `git switch -c spike/rpc-log-pushdown` (keeps the uncommitted prototype in the working tree).
4. Commit the prototype as the baseline, **excluding `.env`**:
   ```bash
   git add package.json pnpm-workspace.yaml src/processor.ts src/main.ts .gitignore   # pnpm-lock.yaml is gitignored in disquid
   git commit -m "spike: RPC-only squid-sdk prototype baseline"
   ```
5. `pnpm install --frozen-lockfile` and `pnpm run build` (runs `tsc`); both must pass.

**Verify:** `git status --short` is empty (`.env` is skip-worktree). `git show --stat HEAD` does not list `.env`. `git log --oneline -1` shows the baseline commit.

### Step 2: Counting JSON-RPC proxy

Create `disquid/scripts/rpc-proxy.mjs` (plain Node ESM, no dependencies, about 80 lines):
- Listens on `127.0.0.1:${PROXY_PORT ?? 8546}`. Forwards each POST body unchanged to `process.env.UPSTREAM_RPC_URL` with `fetch`, and returns the upstream status, `content-type` and body.
- Parses the request body as JSON. For a single request count `method` once; for a batch (array) count **each element** (Quicknode bills per element). Also count HTTP requests separately and keep `batchSizes` (a histogram: 1, 2–10, 11–100, 101+).
- For `eth_getLogs`, record whether params had `topics`, `address` and `blockHash`, and the block span `toBlock - fromBlock + 1` (histogram).
- Sums response bytes per method (for a batch, split the byte total evenly across elements; note this in the output).
- Counts upstream JSON-RPC errors per method and per `error.message` (truncate messages to 120 chars, never include the URL).
- On `SIGINT`/`SIGTERM`, and every 10 s, writes `out/rpc-stats-${PROXY_LABEL}.json`: `{label, startedAt, elapsedMs, httpRequests, calls: {method: n}, bytes: {method: n}, errors: {...}, batchSizes, getLogs: {withTopics, withAddress, byHash, spanHistogram}}`.
- Never logs or writes the upstream URL.

Run it with the upstream URL taken from `.env` without echoing it:
```bash
node --env-file=.env -e "process.env.UPSTREAM_RPC_URL=process.env.RPC_URL; await import('./scripts/rpc-proxy.mjs')" 
```
(or have the script read `RPC_URL` itself when `UPSTREAM_RPC_URL` is unset). Processor runs then use `RPC_URL=http://127.0.0.1:8546`.

**Verify:** with the proxy running,
`curl -s -X POST localhost:8546 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` returns a block number, and after 10 s `out/rpc-stats-*.json` shows `eth_blockNumber: 1`. `grep -c quiknode out/*.json` (or the provider host) prints 0.

### Step 3: A measurable processor config

Change `src/processor.ts` and `src/main.ts` so a run is a fixed, comparable job. Drive it with env vars so the same code runs all variants:
- `SPIKE_FROM` (default `25933634`), `SPIKE_TO` (default `25934633`, so 1,000 blocks), `SPIKE_LABEL` (output file name), `SPIKE_PUSHDOWN` (`1` = on), `SPIKE_STRIDE` (default 5), `SPIKE_HEAD_POLL_MS` (default unset).
- `addLog({where: {topic0: [TRANSFER]}, range: {from: SPIKE_FROM, to: SPIKE_TO}})`: **wildcard address**, which is i-see-u's workload. Keep `USDC` as a commented alternative.
- `setFields({block: {timestamp: true}, log: {address: true, topics: true, data: true, transactionHash: true, logIndex: true}})`. Add `includeAllBlocks: true` to the request if the builder supports it (check `EvmQueryBuilder` in `squid-sdk/src/evm/query-builder.ts`); i-see-u needs every header.
- Handler: append one JSON line per log to `out/transfers-${SPIKE_LABEL}.jsonl`: `{b: block.header.number, h: block.header.hash, i: log.logIndex, tx: log.transactionHash, a: log.address, t: log.topics, d: log.data}`, and one line per block to `out/blocks-${SPIKE_LABEL}.jsonl`: `{b, h, p: parentHash}` (select `parentHash`/`hash` in block fields if they are not default). Use `fs.appendFileSync` per batch, not per log. Remove the per-log `console.log`.
- Keep `TypeormDatabase({supportHotBlocks: true})`. Start Postgres with the repo's `docker-compose.yml` (`docker compose up -d`) and use `DB_*` env as the template expects. Before each run, reset processor state so each run starts at `SPIKE_FROM`: `docker compose exec db psql -U postgres -c 'drop schema if exists squid_processor cascade'` (check the actual status schema name in `typeorm-store/src/database.ts` first).
- Make the process exit when the range is done (it should; if `run()` keeps polling past `to`, stop it when `out/blocks-*.jsonl` reaches `SPIKE_TO` and record that).

**Verify:** `pnpm run build` passes. Nothing else to check yet; Step 4 runs it.

### Step 4: Baseline measurement (unpatched)

Run twice with pushdown off and the default stride, each behind the proxy with its own label:
```bash
PROXY_LABEL=base-a node scripts/rpc-proxy.mjs &      # as in Step 2
RPC_URL=http://127.0.0.1:8546 SPIKE_LABEL=base-a node -r dotenv/config lib/main.js
```
(Re-export `RPC_URL` **after** `dotenv` loads, or give the processor a separate `SPIKE_RPC_URL` that wins over `RPC_URL`; do not edit `.env`.) Stop the proxy after each run so it writes its final stats. Repeat with `base-b`.

**Verify:**
- `out/blocks-base-a.jsonl` has exactly 1,000 distinct block numbers, `SPIKE_FROM..SPIKE_TO`, and every `p` equals the previous line's `h`.
- `sort out/transfers-base-a.jsonl | sha256sum` equals the same for `base-b`. If not, STOP (the provider is not deterministic for this range and parity cannot be judged).
- `out/rpc-stats-base-a.json`: expect about 1,000 `eth_getBlockByNumber` calls and about 200 `eth_getLogs` (span 5, no topics). Record calls, bytes and elapsed time in the Results table.
- Cross-check the Transfer count against i-see-u's method for one block: `eth_getLogs({fromBlock, toBlock: same, topics: [TRANSFER]})` through the proxy for `SPIKE_FROM`, and compare with the count of `b == SPIKE_FROM` lines.

### Step 5: Patch `@subsquid/evm-rpc` 0.2.0

```bash
pnpm patch @subsquid/evm-rpc@0.2.0      # prints a temp directory; edit there
```
Edit **`lib/*.js` (runtime) and `lib/*.d.ts` (types)**; mirror the same change into `src/*.ts` so the patch stays readable. pnpm 10 records the patch in `pnpm-workspace.yaml` (`patchedDependencies`) and writes `patches/@subsquid__evm-rpc@0.2.0.patch`.

1. **Types** (`src/types.ts`, `lib/types.d.ts`):
   ```ts
   export interface LogsFilter {
       /** Lower-cased addresses; omitted = any address. */
       address?: string[]
       /** eth_getLogs topic positions; only topic0 is used by squid-sdk. */
       topics?: (string[] | null)[]
   }
   export interface DataRequest {
       ...existing...
       /** When set, eth_getLogs is filtered on the node; the caller must still filter client-side. */
       logsFilter?: LogsFilter
   }
   ```
2. **`addRequestedData`**: pass the filter: `subtasks.push(this.addLogs(blocks, req.logsFilter))`.
3. **`addLogs(blocks, filter?)`**: if `filter` is undefined, keep the current body **byte for byte**. Otherwise:
   - Guard: if `this.verifyLogsBloom || this.checkLogIndex`, throw `new Error('logsFilter cannot be combined with verifyLogsBloom or checkLogIndex: filtered logs do not cover the whole block')`.
   - `let raw = await this.getLogsSplit(fromQty, toQty, filter)` where `fromQty = blocks[0].block.number`, `toQty = last(blocks).block.number`.
   - Build `byNumber = new Map(blocks.map(b => [b.number, b]))`, `logsFor = new Map<number, Log[]>()` and `suspect = new Set<number>()`. For each log: `n = qty2Int(log.blockNumber)`; if `!byNumber.has(n)` → this is an out-of-range log: throw an error with context `{fromBlock, toBlock, logBlock: n}` (a provider bug; failing loudly is right). If `log.removed === true` or `log.blockHash !== byNumber.get(n).hash` → `suspect.add(n)`; else push to `logsFor[n]`.
   - For each `n` in `suspect`: `logsFor.set(n, await this.getLogsByHash(block.hash, filter))`, where `getLogsByHash` calls `eth_getLogs [{blockHash, topics, address}]` and validates that every returned log has that `blockHash`. If the call fails with an unknown-block error (message contains `not found`, `unknown block` or `header not found`, case-insensitive), set `block._isInvalid = true` and `block._errorMessage = 'eth_getLogs: block ' + n + ' hash ' + hash + ' not on the node canonical chain'` and continue.
   - Assign `block.logs = logsFor.get(block.number) ?? []` for every block that is not `_isInvalid`. Keep logs in the order returned (ascending `logIndex`); sort by `logIndex` to be safe.
   - Check how `Log` is validated (`getResultValidator(array(Log))`): if the `Log` validator rejects `removed`, read it before validation or extend the check; do not loosen the validator for other fields.
4. **`getLogsSplit(from, to, filter)`** (new private method): one `eth_getLogs [{fromBlock, toBlock, topics, address}]` (omit `address` when undefined; omit `topics` when undefined). Keep the existing Avalanche `after last accepted block` → `[]` mapping. On error:
   - `splittable = isTooLarge(err) || (isTimeout(err) && from < to)`.
   - `isTooLarge`: `RpcError` whose lower-cased `message` matches the i-see-u regex above, or HTTP status 413 (check how `@subsquid/rpc-client` exposes HTTP errors in `rpc-client/lib`; it may be an `HttpError` with `response.status`).
   - `isTimeout`: the timeout error class used by `@subsquid/rpc-client` (find it in `rpc-client/lib`, likely `RpcConnectionError` or a timeout from `http-client`). If it cannot be told apart from other connection errors, split only on too-large and record that in Results.
   - If not splittable or `from == to`, rethrow. Else split at the provider's suggested range (parse `block range [0x.., 0x..]` from the message; use it only when its start equals `from` and its end is below `to`), otherwise at the midpoint, and recurse **sequentially** (concurrency already comes from `strideConcurrency`). Log one `warn` per split with `{fromBlock, toBlock, reason}`.
   - Note the client's own retries: `this.call` already retries transient errors per its `retryAttempts`. Do not add another retry layer.
5. Nothing else in `evm-rpc` changes. In particular `getBlockBatch` already sends `eth_getBlockByNumber(n, false)` when `req.transactions` is false, and `verifyTxRoot`/`verifyTxSender` are already skipped then.

`pnpm patch-commit <temp dir>`; `pnpm install`.

**Verify:** `grep -n "logsFilter" node_modules/@subsquid/evm-rpc/lib/rpc.js` shows the new code; `git diff --stat` shows the new patch file and the workspace entry; `pnpm run build` passes; a baseline run (pushdown off) for blocks `SPIKE_FROM..SPIKE_FROM+49` produces the same stats shape as Step 4 (no `topics` in any `eth_getLogs`).

### Step 6: Patch `@subsquid/evm-normalization` 0.1.0

`pnpm patch @subsquid/evm-normalization@0.1.0`. In `mapRpcBlock` (`src/mapping.ts:702`, and `lib/mapping.js`):
```ts
    let txs = src.block.transactions
    let hashesOnly = txs.length > 0 && txs.every(tx => typeof tx === 'string')
    if (hashesOnly) {
        // Header-only fetch: nothing to map. Receipts, traces and state diffs are never
        // requested together with a header-only fetch (squid-sdk guarantees it).
        assert(src.receipts == null && src.traceReplays == null && src.debugFrames == null && src.debugStateDiffs == null)
    } else {
        for (let i = 0; i < txs.length; i++) { ...existing loop body, including assert(typeof tx !== 'string')... }
    }
```
Mixed arrays still hit the original assert. `pnpm patch-commit`, `pnpm install`.

**Verify:** `node -e` against the patched lib: `mapRpcBlock({number: 1, hash: '0x..', block: {...minimal header..., transactions: ['0xaa']}, logs: []})` returns `transactions: []`, and the same block with a full tx object maps as before. Write this as `scripts/selftest-pushdown.mjs` (Step 8 extends it).

### Step 7: Patch `@subsquid/squid-sdk` 0.6.2

`pnpm patch @subsquid/squid-sdk@0.6.2`. Files: `lib/evm/rpc/filter/request.js` (+ `.d.ts`, `src/...`), `lib/evm/rpc/source/data-source.js` (+ `.d.ts`), `lib/evm/rpc/builder.js` (+ `.d.ts`).

1. **`filter/request`**: export `transactionsRequested`. Add:
   ```ts
   export function logsPushdownFilter(requests: FlatDataRequest[]): LogsFilter | undefined
   ```
   implementing the "Logs filter rule" from Design exactly. Import the `LogsFilter` type from `@subsquid/evm-rpc` (patched in Step 5). Also add:
   ```ts
   export function needsTransactions(requests: FlatDataRequest[], fields: FieldSelection, coarse: RequiredData): boolean
   ```
   implementing the "Header-only rule".
2. **`source/data-source`**: `EvmRpcStreamOptions` gains `logFilterPushdown?: boolean` and `headPollInterval?: number`. In the constructor:
   ```ts
   let pushdown = options.logFilterPushdown === true
   let req: RpcDataRequest = {
       transactions: pushdown ? needsTransactions(flatList, options.fields, coarse) : true,
       logs: coarse.logs,
       logsFilter: pushdown && coarse.logs ? logsPushdownFilter(flatList) : undefined,
       ...rest unchanged
   }
   this.inner = new EvmRpcDataSource({rpc, req, strideSize, strideConcurrency, headPollInterval: options.headPollInterval})
   ```
   Keep the existing comment about `transactions: true` and add one line that pushdown can lower it. Check `decodeBlock` (`decode/decode.ts`) and `setUpRelations`/`filterBlock` (`filter/filter.ts`) handle `transactions: []` when logs exist: logs carry `transactionHash`/`transactionIndex` themselves; a log→transaction relation is only built when requested, and the header-only rule excludes that case. If either function dereferences a transaction for every log regardless of the request, STOP.
3. **`builder`**: `EvmRpcOptions` gains
   ```ts
   /** Push the union of requested topic0 (and addresses) into eth_getLogs and fetch header-only
    *  blocks when no transaction data is needed. Requires rpc: {verifyLogsBloom: false, checkLogIndex: false}. */
   logFilterPushdown?: boolean
   /** Pause between head polls once caught up (default 100 ms). */
   headPollInterval?: number
   ```
   In `evmRpcStream`, after `resolveNetworkSettings`: if `config.logFilterPushdown && (settings.rpc.verifyLogsBloom || settings.rpc.checkLogIndex)` throw the error described in Design. Pass `logFilterPushdown` and `headPollInterval` into `EvmRpcStreamDataSource`. Leave `warnIfParityUnverified` as is.
4. `pnpm patch-commit`, `pnpm install`, `pnpm run build`.

**Verify:** `grep -n "logFilterPushdown" node_modules/@subsquid/squid-sdk/lib/evm/rpc/builder.js node_modules/@subsquid/squid-sdk/lib/evm/rpc/source/data-source.js` hits both; `tsc` in disquid passes with `setRpc({..., logFilterPushdown: true, headPollInterval: 3000})`.

### Step 8: Offline self-test

Extend `scripts/selftest-pushdown.mjs` (Node `assert`, no framework) to require the patched libs and check:
- `logsPushdownFilter`:
  - `[{logs: [{topic0: [T]}]}]` → `{topics: [[T]]}` (no address).
  - `[{logs: [{address: [A], topic0: [T]}]}, {logs: [{address: [B], topic0: [T, U]}]}]` → topics `[[T, U]]`, address `[A, B]` (lower-cased, deduped).
  - one item without `topic0` → `undefined`.
  - `[{logs: [{topic0: [T]}], transactions: [{to: [X], logs: true}]}]` → `undefined`.
  - `[{traces: [{type: ['call'], transactionLogs: true}]}]` → `undefined`.
- `needsTransactions`: false for a logs-only request with log fields only; true with `{logs: [{topic0: [T], transaction: true}]}`; true with `fields.transaction = {hash: true}`; true when `coarse.traces`.
- Builder guard: `new EvmRpcDataSourceBuilder().setRpc({url: 'http://127.0.0.1:1', network: 'ethereum-mainnet', logFilterPushdown: true}).addLog({where: {topic0: [T]}}).build()` throws mentioning `verifyLogsBloom`; with `rpc: {verifyLogsBloom: false, checkLogIndex: false}` it builds.
- `mapRpcBlock` header-only case from Step 6.
- `Rpc.addLogs` membership and split, with a fake `EvmRpcClient`-shaped object (only `call`, `batchCall`, `getConcurrency`, `url`, `isConnectionError` are used; check `rpc.ts` for any other member before faking): first `eth_getLogs` over 10 blocks throws `RpcError` "query returned more than 10000 results" → two half-range calls; one log with a foreign `blockHash` for block 3 → exactly one `eth_getLogs({blockHash})` for block 3, whose result replaces block 3's logs. Reach `addLogs` through `getBlockBatch(numbers, {logs: true, logsFilter})` with `verifyBlockHash` off, and answer `eth_chainId` with `0x1`.

**Verify:** `node scripts/selftest-pushdown.mjs` exits 0 and prints one line per case.

### Step 9: Patched measurement

Review gate: before spending credits, the dispatcher (or a reviewer agent) reviews `git diff baseline..HEAD` plus `patches/*.patch`. Continue only after approval.

Set in the processor (driven by the Step 3 env vars):
```ts
.setRpc({
    url: rpcUrl,
    network: 'ethereum-mainnet',
    logFilterPushdown: pushdown,
    strideSize: stride,
    headPollInterval: headPollMs,
    rpc: pushdown ? {verifyLogsBloom: false, checkLogIndex: false} : undefined,
})
```
Runs over the same 1,000 blocks, each behind the proxy with its own label:

| Label | Pushdown | Stride |
|---|---|---|
| `push-5` | on | 5 |
| `push-100` | on | 100 |
| `push-500` | on | 500 |

**Verify (each run):**
- `sort out/transfers-push-N.jsonl | sha256sum` equals `base-a`. If not, diff the sorted files, save the first 20 differing lines to `out/parity-diff-push-N.txt`, and STOP.
- `out/blocks-push-N.jsonl` has 1,000 blocks with a continuous hash chain identical to `base-a` (`diff <(sort out/blocks-base-a.jsonl) <(sort out/blocks-push-N.jsonl)` is empty).
- Stats: `eth_getBlockByNumber` about 1,000 (plus a few `latest`/`finalized`), with much smaller bytes per call than base; every `eth_getLogs` has `topics` and no `address`; span histogram matches the stride (or smaller, if split). Record whether any split or by-hash refetch happened.
- With stride 500, if the provider rejects 500-element header batches, `reduceBatchOnRetry` halves them (warnings in the processor log). Record the effective batch sizes from the histogram; it is not a failure.

Expected (to be confirmed): `push-500` ≈ 1,000 header calls + 2 `eth_getLogs`, the same count as i-see-u's follower for the same blocks (`ETH_FOLLOWER_MAX_RANGE=500`, header concurrency 8).

### Step 10: Head-mode sample (10 minutes)

Run with pushdown on, stride 5, `SPIKE_HEAD_POLL_MS=3000`, `SPIKE_FROM` = current finalized head minus 100 (get it with `eth_getBlockByNumber('finalized', false)` through the proxy), and no `SPIKE_TO`, for 10 minutes behind the proxy (`PROXY_LABEL=head-3000`). Then 2 minutes with `SPIKE_HEAD_POLL_MS` unset (`head-default`, 100 ms) to measure the default's cost; stop it early if the call rate exceeds 20/s.

**Verify / record:**
- Calls per minute by method for both. Expected for `head-3000`: about 20 `latest` polls/min, about 5 headers + about 5 `eth_getLogs`/min, about 12 `finalized` refreshes/min (5 s throttle), plus whatever the finalizer probes. Compare with i-see-u's tail: about 1.2 header calls + 1 `getLogs` per block (about 6–7 calls/min, i-see-u `PROGRESS.md` §13).
- Whether any `ForkException`/rollback happened (grep the processor log for `fork`, `rollback`), and whether any by-hash refetch happened in head mode.
- Lag: last block in `out/blocks-head-3000.jsonl` vs `latest` when you stop it.

### Step 11: Write up

1. Fill in "Results" below (tables plus 3–6 bullets of findings).
2. In disquid, commit on `spike/rpc-log-pushdown` with explicit paths: `SPIKE-rpc-log-pushdown.md`, `scripts/`, `src/`, `patches/`, `pnpm-workspace.yaml`, `.gitignore` (`pnpm-lock.yaml` is gitignored; the patches are recorded in `pnpm-workspace.yaml` `patchedDependencies`). Never `.env` or `out/` (copy the stats JSON files you want to keep into the Results section instead, without URLs). Then `git update-index --no-skip-worktree .env`.

## STOP conditions

- Drift check shows other package versions, or an excerpt above does not match the installed code you must patch.
- `.env` (or the RPC URL/key) appears in any commit, `git show --stat`, or output file.
- The two baseline runs disagree (Step 4).
- Any patched run disagrees with the baseline on Transfers or block hashes (Step 9).
- `decodeBlock`, `setUpRelations` or `filterBlock` need transaction objects for logs-only requests (Step 7.2), or making header-only work would require changing filter semantics.
- `Rpc` relies on client members your fake cannot provide in a way that requires patching more than `addLogs`/`addRequestedData` and the new helpers.
- Credits: stop any run that exceeds 50,000 proxied calls (base stride 5 over 1,000 blocks should be about 1,200).

## Rollback

All changes are in disquid on `spike/rpc-log-pushdown`: `git switch -` returns to the previous branch with the prototype; `pnpm patch-remove @subsquid/evm-rpc@0.2.0 @subsquid/evm-normalization@0.1.0 @subsquid/squid-sdk@0.6.2` (or delete `patches/` and the `patchedDependencies` entry, then `pnpm install`) restores the stock packages.

## Out of scope / follow-ups

- **Upstreaming.** The change is generic (opt-in, superset filter, client filter authoritative). If it measures well, it is a reasonable PR to `subsquid/squid-sdk` (GPL-3.0-or-later). Ask Viktor first.
- **Using it in i-see-u.** As a bootstrap `src/sources/` implementation it would emit header chains and Transfer logs to `appendRange`. It would not replace the follower, tail, repair or readiness (REPORT "Handoffs and limits").
- **Logs-bloom verification in i-see-u** without SQD: needs unfiltered per-block logs or `eth_getBlockReceipts`, which is a separate cost trade-off.
- **Finalizer probe cost** in head mode (`evm-rpc/src/data-source/finalizer.ts`) is only measured here, not tuned.

## Results

_Fill in after Step 11._

| Run | Blocks | `eth_getBlockByNumber` | `eth_getLogs` | Other calls | Response MB | Wall time | Transfers | Parity |
|---|---|---|---|---|---|---|---|---|
| base-a | 1,000 | | | | | | | reference |
| base-b | 1,000 | | | | | | | |
| push-5 | 1,000 | | | | | | | |
| push-100 | 1,000 | | | | | | | |
| push-500 | 1,000 | | | | | | | |

| Head run | Minutes | Calls/min by method | Forks | By-hash refetches | Lag at stop |
|---|---|---|---|---|---|
| head-3000 | 10 | | | | |
| head-default | 2 | | | | |

Findings:
- 
