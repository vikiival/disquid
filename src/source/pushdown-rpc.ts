import {
    Block,
    Commitment,
    DataRequest,
    EvmRpcClient,
    GetBlock,
    LatestBlockhash,
    Log,
    qty2Int,
    Rpc,
    RpcOptions,
    toQty,
} from '@subsquid/evm-rpc'
import {isBloomSuperset, logsBloom} from '@subsquid/evm-rpc/lib/verification'
import {createLogger} from '@subsquid/logger'
import type {CallOptions} from '@subsquid/rpc-client'
import {wait} from '@subsquid/util-internal'

import {isTimeout, isTooLarge, isUnknownBlock, suggestedRange} from './errors'
import {LogsFilter} from './request'

export interface PushdownRpcOptions extends RpcOptions {
    client: EvmRpcClient
    /**
     * Serve header-only + logs requests with `eth_getBlockByNumber(n, false)` and a filtered
     * `eth_getLogs`. Turns off `verifyLogsBloom` / `checkLogIndex`: filtered logs are not the
     * whole block, so the log/header hash check and the empty-block bloom check replace them.
     */
    pushdown?: boolean
    logsFilter?: LogsFilter
    /** Upper bound of blocks per `eth_getLogs` (default: the whole batch). */
    maxLogsRange?: number
    /** Retries of `eth_getLogs` on connection errors and rate limits (this layer retries itself). */
    retryAttempts?: number
    retrySchedule?: number[]
    /** Reuse the `finalized` head for this long (ms); finality moves once per 6.4 min epoch. */
    finalizedHeadTtl?: number
    /** Chain slot time (s). When set, `latest` is not re-polled before the next slot is due. */
    slotTime?: number
    /** How long after the next slot's timestamp polling resumes (ms). */
    slotGrace?: number
    /**
     * A block whose filtered logs came back empty while its header bloom admits a match is
     * re-fetched by hash: catches a lagging node that answers a range with nothing.
     */
    checkEmptyBlocksBloom?: boolean
}

interface HeadState {
    number: number
    hash: string
    recheckAt: number
}

// A `latest` header is reused for the by-number fetch that follows the poll, never later.
const HEAD_HEADER_MAX_AGE = 5_000
const ZERO_BLOOM = /^0x0*$/

class SplitRange extends Error {
    constructor(readonly reason: unknown) {
        super('split eth_getLogs range')
    }
}

/**
 * `Rpc` that fetches header-only blocks plus node-side filtered logs, and trims the head-mode
 * call pattern (gated `latest` polls, a cached `finalized` head, header reuse).
 *
 * Every pushed-down log must carry the hash of the header fetched for its number. A block
 * that fails this (a load-balanced node on another fork or behind) is re-fetched by block hash
 * and, if still inconsistent, cut from the batch so the caller re-requests it; never dropped.
 */
export class PushdownRpc extends Rpc {
    private rpcClient: EvmRpcClient
    private pushdown: boolean
    private filter: LogsFilter
    private maxLogsRange: number
    private logsRetryAttempts: number
    private logsRetrySchedule: number[]
    private finalizedHeadTtl: number
    private slotTime: number
    private slotGrace: number
    private checkEmptyBlocksBloom: boolean
    private fullBloomCheck: boolean
    private topic0Blooms?: string[]
    private addressBlooms?: string[]
    private logger = createLogger('sqd:rpc-pushdown')

    private finalized?: {ref: LatestBlockhash; at: number}
    private finalizedPending?: Promise<LatestBlockhash>
    private latest?: HeadState
    private latestPending?: Promise<LatestBlockhash>
    private headHeader?: {block: GetBlock; at: number}

    constructor(options: PushdownRpcOptions) {
        let pushdown = options.pushdown ?? false
        super(pushdown ? {...options, verifyLogsBloom: false, checkLogIndex: false} : options)
        this.rpcClient = options.client
        this.pushdown = pushdown
        this.filter = options.logsFilter ?? {}
        this.maxLogsRange = Math.max(1, options.maxLogsRange ?? Number.MAX_SAFE_INTEGER)
        this.logsRetryAttempts = options.retryAttempts ?? Number.MAX_SAFE_INTEGER
        this.logsRetrySchedule = options.retrySchedule?.length ? options.retrySchedule : [100, 500, 2000, 5000, 10000, 20000]
        this.finalizedHeadTtl = options.finalizedHeadTtl ?? 60_000
        this.slotTime = options.slotTime ?? 0
        this.slotGrace = options.slotGrace ?? 2_000
        this.checkEmptyBlocksBloom = options.checkEmptyBlocksBloom ?? true
        // Unfiltered logs are the whole block, so the exact bloom check still applies.
        this.fullBloomCheck = !!options.verifyLogsBloom && this.filter.topic0 == null && this.filter.address == null
        this.topic0Blooms = this.filter.topic0?.map(bloomOf)
        this.addressBlooms = this.filter.address?.map(bloomOf)
    }

    async getLatestBlockhash(commitment: Commitment): Promise<LatestBlockhash> {
        return commitment == 'finalized' ? this.getFinalizedHead() : this.getLatestHead()
    }

    /**
     * The finalizer probes up to 5 hot blocks every 500 ms, each probe costing a `finalized`
     * call plus a header batch. Matching the highest finalized probe is all it needs (the
     * stream is parent-hash continuous, so the lower ones are its ancestors), and other
     * entries may be null, which it skips.
     */
    async getFinalizedBlockBatch(numbers: number[]): Promise<Block[]> {
        let head = await this.getFinalizedHead()
        let finalized = numbers.filter((n) => n <= head.number)
        if (finalized.length == 0) return []
        let top = finalized.indexOf(Math.max(...finalized))
        let result: (Block | null)[] = finalized.map(() => null)
        if (finalized[top] == head.number) {
            // Only `hash` is read by the finalizer.
            result[top] = {number: head.number, hash: head.hash, block: {number: toQty(head.number), hash: head.hash} as GetBlock}
        } else {
            let [block] = await this.getBlockBatch([finalized[top]])
            result[top] = block ?? null
        }
        return result as Block[]
    }

    async getBlockBatch(numbers: number[], req?: DataRequest): Promise<Block[]> {
        if (req?.transactions || req?.receipts || req?.traces || req?.stateDiffs) {
            return super.getBlockBatch(numbers, req)
        }
        let withLogs = !!req?.logs && this.pushdown
        let chain = await super.getBlockBatch(numbers, withLogs ? {...req, logs: false} : req)
        // mapRpcBlock asserts every transaction is an object; hashes are of no use here.
        for (let block of chain) block.block.transactions = []
        return withLogs ? this.attachLogs(chain) : chain
    }

    /**
     * Blocks `from..to` built from one filtered `eth_getLogs` pass, for finalized ranges only:
     * number, hash and timestamp come from the logs (`blockHash`, `blockTimestamp`). A header is
     * fetched only for a block the logs cannot describe: one without a matching log (the bloom
     * check then catches a node that answers an unknown range with nothing), one whose logs lack
     * `blockTimestamp`, or one whose logs disagree on the hash. `parentHash` of a block built from
     * logs is left empty for the caller to link; finalized blocks are not checked for forks.
     */
    async getLogsOnlyBlocks(from: number, to: number): Promise<Block[]> {
        let logs = await this.getLogsRange(from, to)
        let found = new Map<number, {hash: string; timestamp?: string; logs: Log[]; bad: boolean}>()
        for (let log of logs) {
            let number = qty2Int(log.blockNumber)
            if (number < from || number > to) {
                this.logger.warn({fromBlock: from, toBlock: to, logBlock: log.blockNumber}, 'eth_getLogs returned a log outside the requested range')
                continue
            }
            let timestamp: string | undefined = (log as any).blockTimestamp ?? undefined
            let entry = found.get(number)
            if (entry == null) {
                entry = {hash: log.blockHash, timestamp, logs: [], bad: false}
                found.set(number, entry)
            }
            if (timestamp == null) entry.timestamp = undefined
            if (log.removed || log.blockHash !== entry.hash) entry.bad = true
            else entry.logs.push(log)
        }

        let needHeader: number[] = []
        for (let n = from; n <= to; n++) {
            let entry = found.get(n)
            if (entry == null || entry.bad || entry.timestamp == null) needHeader.push(n)
        }
        let headers = await this.getHeaders(needHeader)

        let chain: Block[] = []
        for (let n = from; n <= to; n++) {
            let entry = found.get(n)
            let header = headers.get(n)
            if (header == null) {
                chain.push(fromLogs(n, entry!.hash, entry!.timestamp!, sortUnique(entry!.logs)))
                continue
            }
            let own = entry == null ? [] : !entry.bad && entry.hash === header.hash ? entry.logs : undefined
            if (own == null || !this.bloomAgrees(header, own)) own = await this.resolveBlockLogs(header)
            if (own == null) throw new Error(`inconsistent logs for finalized block ${n}#${header.hash}`)
            header.logs = sortUnique(own)
            chain.push(header)
        }
        return chain
    }

    /** Header-only blocks by number; contiguous runs share one batch call. */
    private async getHeaders(numbers: number[]): Promise<Map<number, Block>> {
        let result = new Map<number, Block>()
        let runs: number[][] = []
        for (let n of numbers) {
            let run = runs[runs.length - 1]
            if (run != null && run[run.length - 1] == n - 1) run.push(n)
            else runs.push([n])
        }
        for (let run of runs) {
            // super: the plain by-number header fetch, which stops at a missing or unlinked block.
            let chain = await super.getBlockBatch(run)
            if (chain.length < run.length) {
                throw new Error(`node returned no header for block ${run[chain.length]}`)
            }
            for (let block of chain) {
                block.block.transactions = []
                result.set(block.number, block)
            }
        }
        return result
    }

    /** Answers a by-number header fetch from the header the last `latest` poll returned. */
    batchCall<T = any>(batch: {method: string; params?: any[]}[], options?: CallOptions<T>): Promise<T[]> {
        let header = this.headHeader
        if (header == null || Date.now() - header.at > HEAD_HEADER_MAX_AGE) {
            return super.batchCall(batch, options)
        }
        let hit = batch.findIndex(
            (c) => c.method == 'eth_getBlockByNumber' && c.params?.[0] === header.block.number && c.params?.[1] === false,
        )
        if (hit < 0) return super.batchCall(batch, options)
        this.headHeader = undefined
        let call = batch[hit]
        let cached = options?.validateResult
            ? options.validateResult(header.block, {id: 0, jsonrpc: '2.0', ...call})
            : (header.block as T)
        let rest = batch.filter((_, i) => i != hit)
        let restResult = rest.length > 0 ? super.batchCall(rest, options) : Promise.resolve([] as T[])
        return restResult.then((results) => [...results.slice(0, hit), cached, ...results.slice(hit)])
    }

    private getFinalizedHead(): Promise<LatestBlockhash> {
        let cached = this.finalized
        if (cached && Date.now() - cached.at < this.finalizedHeadTtl) return Promise.resolve(cached.ref)
        this.finalizedPending ??= super
            .getLatestBlockhash('finalized')
            .then((ref) => {
                // A lagging node behind a load balancer may report an older head; keep the newer one.
                let prev = this.finalized?.ref
                let next = prev && prev.number > ref.number ? prev : ref
                this.finalized = {ref: next, at: Date.now()}
                return next
            })
            .finally(() => (this.finalizedPending = undefined))
        return this.finalizedPending
    }

    /**
     * Blocks arrive once per slot, so polling `latest` before the next slot is due is wasted.
     * The gate is capped at one slot after the fetch, which bounds a local clock that runs late.
     */
    private getLatestHead(): Promise<LatestBlockhash> {
        let latest = this.latest
        if (latest && Date.now() < latest.recheckAt) return Promise.resolve({number: latest.number, hash: latest.hash})
        this.latestPending ??= this.fetchLatest().finally(() => (this.latestPending = undefined))
        return this.latestPending
    }

    private async fetchLatest(): Promise<LatestBlockhash> {
        let block: GetBlock = await this.call('eth_getBlockByNumber', ['latest', false], {
            validateResult: (result) => validated(GetBlock, result),
        })
        let number = qty2Int(block.number)
        let fetchedAt = Date.now()
        let recheckAt = fetchedAt
        if (this.slotTime > 0 && (this.latest == null || number > this.latest.number)) {
            let nextSlot = (qty2Int(block.timestamp) + this.slotTime) * 1000 + this.slotGrace
            recheckAt = Math.min(nextSlot, fetchedAt + this.slotTime * 1000)
        }
        this.latest = {number, hash: block.hash, recheckAt}
        this.headHeader = {block, at: fetchedAt}
        return {number, hash: block.hash}
    }

    private async attachLogs(chain: Block[]): Promise<Block[]> {
        if (chain.length == 0) return chain
        let from = chain[0].number
        let to = chain[chain.length - 1].number
        let logs = await this.getLogsRange(from, to)

        let index = new Map(chain.map((b, i) => [b.number, i]))
        let byBlock = chain.map((): Log[] => [])
        let suspect = new Set<number>()
        for (let log of logs) {
            let i = index.get(qty2Int(log.blockNumber))
            if (i == null) {
                this.logger.warn({fromBlock: from, toBlock: to, logBlock: log.blockNumber}, 'eth_getLogs returned a log outside the requested range')
                continue
            }
            if (log.removed || log.blockHash !== chain[i].hash) {
                suspect.add(i)
            } else {
                byBlock[i].push(log)
            }
        }
        for (let i = 0; i < chain.length; i++) {
            if (!suspect.has(i) && !this.bloomAgrees(chain[i], byBlock[i])) suspect.add(i)
        }

        for (let i of [...suspect].sort((a, b) => a - b)) {
            let resolved = await this.resolveBlockLogs(chain[i])
            if (resolved == null) {
                // Cut the batch here: callers re-request missing blocks (header and logs).
                chain = chain.slice(0, i)
                break
            }
            byBlock[i] = resolved
        }

        for (let i = 0; i < chain.length; i++) {
            chain[i].logs = sortUnique(byBlock[i])
        }
        return chain
    }

    /**
     * Logs for one block by its hash (EIP-234). If that fails or disagrees with the header, the
     * header is re-read by number: a different hash means it came from a stale node.
     */
    private async resolveBlockLogs(block: Block): Promise<Log[] | undefined> {
        let ctx = {blockNumber: block.number, blockHash: block.hash}
        for (let attempt = 0; attempt < 3; attempt++) {
            let problem: string
            try {
                let logs = await this.getLogs({blockHash: block.hash}, false)
                let consistent = logs.every(
                    (l) => !l.removed && l.blockHash === block.hash && qty2Int(l.blockNumber) === block.number,
                )
                if (consistent && (!this.fullBloomCheck || this.bloomAgrees(block, logs))) {
                    if (attempt > 0) this.logger.info(ctx, 'block logs resolved by hash')
                    else this.logger.debug(ctx, 'block logs re-fetched by hash')
                    return logs
                }
                problem = 'logs by hash disagree with the header'
            } catch (err: any) {
                if (!isUnknownBlock(err)) throw err
                problem = err.message
            }
            this.headHeader = undefined
            let [fresh] = await super.getBlockBatch([block.number])
            if (fresh?.hash !== block.hash) {
                this.logger.warn({...ctx, freshHash: fresh?.hash, problem}, 'header changed since it was fetched, re-requesting the block')
                return undefined
            }
            this.logger.warn({...ctx, problem, attempt}, 'inconsistent logs for a canonical header')
            await wait(500 * (attempt + 1))
        }
        return undefined
    }

    private bloomAgrees(block: Block, logs: Log[]): boolean {
        let bloom = block.block.logsBloom
        if (this.fullBloomCheck) return logsBloom(logs) === bloom
        if (logs.length > 0 || !this.checkEmptyBlocksBloom) return true
        return !mayContain(bloom, this.topic0Blooms, this.addressBlooms)
    }

    private async getLogsRange(from: number, to: number): Promise<Log[]> {
        if (to - from + 1 > this.maxLogsRange) {
            let logs: Log[] = []
            for (let beg = from; beg <= to; beg += this.maxLogsRange) {
                logs.push(...(await this.getLogsRange(beg, Math.min(to, beg + this.maxLogsRange - 1))))
            }
            return logs
        }
        try {
            return await this.getLogs({fromBlock: toQty(from), toBlock: toQty(to)}, from < to)
        } catch (err) {
            if (!(err instanceof SplitRange)) throw err
            let hint = suggestedRange(err.reason)
            let mid = hint && hint.from == from && hint.to >= from && hint.to < to ? hint.to : Math.floor((from + to) / 2)
            this.logger.warn(
                {fromBlock: from, toBlock: to, splitAt: mid, reason: (err.reason as Error)?.message},
                'splitting eth_getLogs range',
            )
            let left = await this.getLogsRange(from, mid)
            let right = await this.getLogsRange(mid + 1, to)
            return left.concat(right)
        }
    }

    private async getLogs(range: {fromBlock: string; toBlock: string} | {blockHash: string}, splittable: boolean): Promise<Log[]> {
        let params: Record<string, unknown> = {...range}
        if (this.filter.address) params.address = this.filter.address
        if (this.filter.topic0) params.topics = [this.filter.topic0]
        for (let attempt = 0; ; attempt++) {
            try {
                // Retried here, not by the client: some providers report "too many results"
                // with the rate-limit code, which the client would retry forever.
                return await this.call('eth_getLogs', [params], {
                    retryAttempts: 0,
                    validateResult: (result) => validatedLogs(result),
                })
            } catch (err: any) {
                if (splittable && (isTooLarge(err) || isTimeout(err))) throw new SplitRange(err)
                // -32000 counts as retryable, but an unknown hash is the caller's to handle.
                if ('blockHash' in range && isUnknownBlock(err)) throw err
                if (attempt >= this.logsRetryAttempts || !this.rpcClient.isConnectionError(err)) throw err
                let pause = this.logsRetrySchedule[Math.min(attempt, this.logsRetrySchedule.length - 1)]
                this.logger.warn({reason: err.message, attempt: attempt + 1, pause}, 'eth_getLogs failed, retrying')
                await wait(pause)
            }
        }
    }
}

function bloomOf(value: string): string {
    // Addresses and topics enter the bloom the same way: keccak of the raw bytes.
    return logsBloom([{address: value, topics: []} as unknown as Log])
}

function mayContain(bloom: string, topic0?: string[], address?: string[]): boolean {
    if (ZERO_BLOOM.test(bloom)) return false
    if (topic0 && !topic0.some((t) => isBloomSuperset(bloom, t))) return false
    if (address && !address.some((a) => isBloomSuperset(bloom, a))) return false
    return true
}

// Only what the stream reads: mapRpcBlock parses `size`, the other header fields are optional.
function fromLogs(number: number, hash: string, timestamp: string, logs: Log[]): Block {
    let block = {number: toQty(number), hash, parentHash: '', timestamp, size: '0x0', transactions: []}
    return {number, hash, block: block as unknown as GetBlock, logs}
}

function sortUnique(logs: Log[]): Log[] {
    let byIndex = new Map<number, Log>()
    for (let log of logs) byIndex.set(qty2Int(log.logIndex), log)
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
}

function validated<T>(validator: {validate(value: unknown): unknown}, value: unknown): T {
    let err = validator.validate(value)
    if (err) throw new Error(`server returned unexpected result: ${err}`)
    return value as T
}

function validatedLogs(result: unknown): Log[] {
    if (!Array.isArray(result)) throw new Error('server returned unexpected result: eth_getLogs result is not an array')
    for (let log of result) validated(Log, log)
    return result
}
