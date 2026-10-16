import {createLogger, type Logger} from '@subsquid/logger'
import {RpcClient} from '@subsquid/rpc-client'
import {BalanceBatcher, type BalanceOutcome, type EthCallTransport} from './batcher'
import {BalanceCache, type CachedBalance} from './cache'
import {balanceConfigFromEnv, type BalanceConfig} from './config'

export type {BalanceErrorCode, BalanceOutcome} from './batcher'
export type {CachedBalance} from './cache'

export interface ServedBlock {
    number: number
    hash: string
}

export interface AccountTokenActivity {
    token: string
    lastSeenBlock: number
}

/** Block number -> hash for the given numbers, read in the caller's snapshot. */
export type CanonicalHashLookup = (numbers: number[]) => Promise<Map<number, string>>

type ServiceConfig = Pick<BalanceConfig,
    'multicallAddress' | 'batchSize' | 'batchWindowMs' | 'concurrency' | 'maxQueuedBatches' |
    'deadlineMs' | 'cacheSize' | 'cacheMaxAgeMs' | 'alwaysRefresh'>

/**
 * On-demand balances for discovered tokens: the change-driven cache in front of the coalescing
 * Multicall3 batcher. Usage per request: {@link fromCache} inside the snapshot transaction, then
 * {@link fetch} for the rest after the transaction is closed (never hold a DB connection over RPC).
 */
export class BalanceService {
    readonly cache: BalanceCache
    readonly batcher: BalanceBatcher
    readonly stats = {cacheHits: 0, cacheMisses: 0}

    constructor(transport: EthCallTransport, private config: ServiceConfig, now: () => number = Date.now) {
        this.cache = new BalanceCache({
            maxEntries: config.cacheSize,
            maxAgeMs: config.cacheMaxAgeMs,
            alwaysRefresh: config.alwaysRefresh,
            now,
        })
        this.batcher = new BalanceBatcher(transport, {
            batchSize: config.batchSize,
            windowMs: config.batchWindowMs,
            concurrency: config.concurrency,
            maxQueuedBatches: config.maxQueuedBatches,
            multicallAddress: config.multicallAddress,
            now,
        })
    }

    /** Cached balances still valid at `served`, verified with one block-hash lookup. */
    async fromCache(
        account: string,
        rows: readonly AccountTokenActivity[],
        served: ServedBlock,
        canonicalHashes: CanonicalHashLookup,
    ): Promise<Map<string, CachedBalance>> {
        let candidates = this.cache.candidates(account, rows, served.number)
        let hits = new Map<string, CachedBalance>()
        if (candidates.size > 0) {
            let numbers = [...new Set([...candidates.values()].map(e => e.block))]
            hits = this.cache.confirm(account, candidates, await canonicalHashes(numbers))
        }
        this.stats.cacheHits += hits.size
        this.stats.cacheMisses += rows.length - hits.size
        return hits
    }

    /** Reads `tokens` balances of `account` at `served.hash`; successes are cached. */
    async fetch(account: string, tokens: readonly string[], served: ServedBlock): Promise<Map<string, BalanceOutcome>> {
        let outcomes = await this.batcher.load(
            served.hash,
            tokens.map(token => ({account, token})),
            this.config.deadlineMs,
        )
        let out = new Map<string, BalanceOutcome>()
        tokens.forEach((token, i) => {
            let outcome = outcomes[i]
            if (outcome.balance !== undefined) {
                this.cache.store(account, token, outcome.balance, served.number, served.hash)
            }
            out.set(token, outcome)
        })
        return out
    }

    snapshotStats(): Record<string, number> {
        return {...this.stats, ...this.batcher.stats, cacheSize: this.cache.size}
    }

    startStatsLog(log: Logger, intervalMs = 60_000): () => void {
        let timer = setInterval(() => log.debug(this.snapshotStats(), 'balance service stats'), intervalMs)
        timer.unref()
        return () => clearInterval(timer)
    }
}

export class RpcEthCallTransport implements EthCallTransport {
    constructor(private client: RpcClient) {}

    ethCall(to: string, data: string, blockHash: string): Promise<string> {
        // EIP-1898: pin to the hash, so the answer belongs to the served block even if a reorg
        // has since replaced the block at that height.
        return this.client.call('eth_call', [{to, data}, {blockHash}])
    }
}

class UnconfiguredTransport implements EthCallTransport {
    private warned = false

    constructor(private log: Logger) {}

    async ethCall(): Promise<string> {
        if (!this.warned) {
            this.warned = true
            this.log.error('balances requested but neither BALANCE_RPC_URL nor RPC_URL is set')
        }
        throw new Error('balance RPC is not configured')
    }
}

let instance: BalanceService | undefined

/** Process-wide service built from env on first use (the cache and batches are shared across requests). */
export function getBalanceService(): BalanceService {
    if (instance == null) {
        let config = balanceConfigFromEnv()
        let log = createLogger('sqd:graphql-server:balances')
        let transport: EthCallTransport = config.rpcUrl
            ? new RpcEthCallTransport(new RpcClient({
                url: config.rpcUrl,
                capacity: config.concurrency,
                rateLimit: config.rpcRateLimit,
                requestTimeout: config.rpcRequestTimeoutMs,
                retryAttempts: 2,
            }))
            : new UnconfiguredTransport(log)
        instance = new BalanceService(transport, config)
        instance.startStatsLog(log)
    }
    return instance
}
