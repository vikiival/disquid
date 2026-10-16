import {MULTICALL3_ADDRESS} from '../../rpc/multicall3'
import {decodeBalanceOfBatch, encodeBalanceOfBatch, type BalanceCall} from './multicall3'

/** Why a balance is missing. Exposed in the API as the `BalanceError` enum. */
export type BalanceErrorCode = 'RPC_BUSY' | 'RPC_TIMEOUT' | 'RPC_ERROR' | 'CALL_FAILED'

export type BalanceOutcome = {balance: bigint; error?: undefined} | {balance?: undefined; error: BalanceErrorCode}

/** One `eth_call` pinned to a block hash (EIP-1898). */
export interface EthCallTransport {
    ethCall(to: string, data: string, blockHash: string): Promise<string>
}

export interface BatcherOptions {
    /** Flush an open batch once it holds this many pairs. */
    batchSize: number
    /** Flush an open batch this long after its first pair arrived. */
    windowMs: number
    /** Max eth_calls in flight. */
    concurrency: number
    /** Max sealed batches waiting for a free slot; beyond that new pairs get RPC_BUSY. */
    maxQueuedBatches: number
    multicallAddress?: string
    now?: () => number
}

export interface BatcherStats {
    rpcCalls: number
    rpcErrors: number
    /** Pairs sent to the node. */
    pairs: number
    /** Pairs that joined an identical in-flight read instead of adding a new one. */
    deduped: number
    busy: number
    timeouts: number
    callFailed: number
}

interface PendingPair extends BalanceCall {
    key: string
    /** Latest deadline of anyone waiting for this pair; past it, nobody needs the answer. */
    deadline: number
    promise: Promise<BalanceOutcome>
    resolve: (outcome: BalanceOutcome) => void
}

interface Batch {
    blockHash: string
    pairs: PendingPair[]
    timer?: ReturnType<typeof setTimeout>
}

/**
 * Coalesces balanceOf reads from concurrent requests into Multicall3 `aggregate3` calls.
 *
 * Pairs for the same block hash share one open batch until it is full or its window elapses;
 * an identical (blockHash, account, token) read already in flight is joined, not repeated.
 * Sealed batches run with bounded concurrency behind a bounded queue, so a slow or failing node
 * turns into per-pair RPC_BUSY / RPC_TIMEOUT answers instead of unbounded memory and latency.
 */
export class BalanceBatcher {
    readonly stats: BatcherStats = {rpcCalls: 0, rpcErrors: 0, pairs: 0, deduped: 0, busy: 0, timeouts: 0, callFailed: 0}

    private inflight = new Map<string, PendingPair>()
    private open = new Map<string, Batch>()
    private queue: Batch[] = []
    private running = 0
    private now: () => number
    private multicall: string

    constructor(private transport: EthCallTransport, private options: BatcherOptions) {
        this.now = options.now ?? Date.now
        this.multicall = options.multicallAddress ?? MULTICALL3_ADDRESS
    }

    /**
     * Balances of `pairs` at `blockHash`, in input order. Never rejects: whatever is not answered
     * within `budgetMs` comes back as RPC_TIMEOUT (the underlying read keeps going and may still
     * serve other requests).
     */
    async load(blockHash: string, pairs: readonly BalanceCall[], budgetMs: number): Promise<BalanceOutcome[]> {
        if (pairs.length === 0) return []
        let deadline = this.now() + budgetMs
        // Not `new Array(n)`: map() skips holes.
        let results: (BalanceOutcome | undefined)[] = pairs.map(() => undefined)
        let all = Promise.all(
            pairs.map((pair, i) => this.enqueue(blockHash, pair, deadline).then(outcome => {
                results[i] = outcome
            })),
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        let timeout = new Promise<void>(resolve => {
            timer = setTimeout(resolve, budgetMs)
        })
        try {
            await Promise.race([all, timeout])
        } finally {
            clearTimeout(timer)
        }
        return results.map(outcome => {
            if (outcome) return outcome
            this.stats.timeouts += 1
            return {error: 'RPC_TIMEOUT'}
        })
    }

    private enqueue(blockHash: string, call: BalanceCall, deadline: number): Promise<BalanceOutcome> {
        let key = `${blockHash}:${call.account}:${call.token}`
        let existing = this.inflight.get(key)
        if (existing) {
            existing.deadline = Math.max(existing.deadline, deadline)
            this.stats.deduped += 1
            return existing.promise
        }

        let batch = this.open.get(blockHash)
        if (batch == null) {
            // Fail fast: a new batch could only wait behind a full queue.
            if (this.queue.length >= this.options.maxQueuedBatches) {
                this.stats.busy += 1
                return Promise.resolve({error: 'RPC_BUSY'})
            }
            let created: Batch = {blockHash, pairs: []}
            created.timer = setTimeout(() => this.seal(created), this.options.windowMs)
            this.open.set(blockHash, created)
            batch = created
        }

        let resolve!: (outcome: BalanceOutcome) => void
        let promise = new Promise<BalanceOutcome>(r => {
            resolve = r
        })
        let pending: PendingPair = {...call, key, deadline, promise, resolve}
        batch.pairs.push(pending)
        this.inflight.set(key, pending)

        if (batch.pairs.length >= this.options.batchSize) {
            this.seal(batch)
        }
        return promise
    }

    private seal(batch: Batch): void {
        clearTimeout(batch.timer)
        if (this.open.get(batch.blockHash) === batch) {
            this.open.delete(batch.blockHash)
        }
        if (this.running < this.options.concurrency) {
            void this.run(batch)
        } else if (this.queue.length < this.options.maxQueuedBatches) {
            this.queue.push(batch)
        } else {
            this.settleAll(batch, {error: 'RPC_BUSY'})
        }
    }

    private async run(batch: Batch): Promise<void> {
        this.running += 1
        try {
            let deadline = Math.max(...batch.pairs.map(p => p.deadline))
            if (this.now() >= deadline) {
                // Everyone waiting has already answered RPC_TIMEOUT; don't spend credits.
                this.settleAll(batch, {error: 'RPC_TIMEOUT'})
                return
            }
            await this.execute(batch)
        } finally {
            this.running -= 1
            let next = this.queue.shift()
            if (next) void this.run(next)
        }
    }

    private async execute(batch: Batch): Promise<void> {
        let balances: (bigint | undefined)[]
        try {
            this.stats.rpcCalls += 1
            this.stats.pairs += batch.pairs.length
            let output = await this.transport.ethCall(this.multicall, encodeBalanceOfBatch(batch.pairs), batch.blockHash)
            balances = decodeBalanceOfBatch(output, batch.pairs.length)
        } catch {
            this.stats.rpcErrors += 1
            this.settleAll(batch, {error: 'RPC_ERROR'})
            return
        }
        batch.pairs.forEach((pair, i) => {
            let balance = balances[i]
            if (balance === undefined) {
                this.stats.callFailed += 1
                this.settle(pair, {error: 'CALL_FAILED'})
            } else {
                this.settle(pair, {balance})
            }
        })
    }

    private settleAll(batch: Batch, outcome: BalanceOutcome): void {
        if (outcome.error === 'RPC_BUSY') this.stats.busy += batch.pairs.length
        for (let pair of batch.pairs) this.settle(pair, outcome)
    }

    private settle(pair: PendingPair, outcome: BalanceOutcome): void {
        if (this.inflight.get(pair.key) === pair) this.inflight.delete(pair.key)
        pair.resolve(outcome)
    }
}
