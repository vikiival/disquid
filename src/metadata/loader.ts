import {RpcClient} from '@subsquid/rpc-client'
import {MULTICALL3_ADDRESS} from '../rpc/multicall3'
import {fetchTokenMetadata, type EthCallClient, type MetadataResult} from './fetch'

export interface MetadataConfig {
    rpcUrl: string
    rpcRateLimit: number
    batchSize: number
    sweepLimit: number
    retryBackoffMs: number
    multicallAddress: string
}

function envInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number, min: number): number {
    let raw = env[name]
    if (raw == null || raw === '') return defaultValue
    let value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min) {
        throw new Error(`Invalid ${name}: ${raw}. Expected an integer >= ${min}`)
    }
    return value
}

export function metadataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MetadataConfig {
    let rpcUrl = env.METADATA_RPC_URL || env.RPC_URL
    if (!rpcUrl) throw new Error('METADATA_RPC_URL or RPC_URL is required')
    return {
        rpcUrl,
        rpcRateLimit: envInt(env, 'METADATA_RPC_RATE_LIMIT', 10, 1),
        batchSize: envInt(env, 'METADATA_BATCH_SIZE', 50, 1),
        sweepLimit: envInt(env, 'METADATA_SWEEP_LIMIT', 200, 0),
        retryBackoffMs: envInt(env, 'METADATA_RETRY_BACKOFF_MS', 60_000, 0),
        multicallAddress: (env.MULTICALL3_ADDRESS || MULTICALL3_ADDRESS).toLowerCase(),
    }
}

/**
 * A client of its own: the ingest client is tuned for throughput and its retries must not be
 * shared with a best-effort side read. Bounded so a bad node costs the batch a few seconds,
 * not minutes.
 */
export function createMetadataClient(config: Pick<MetadataConfig, 'rpcUrl' | 'rpcRateLimit'>): EthCallClient {
    return new RpcClient({
        url: config.rpcUrl,
        rateLimit: config.rpcRateLimit,
        requestTimeout: 15_000,
        retryAttempts: 3,
    })
}

/**
 * Fetches metadata for the processor and remembers when the node stopped answering: after a
 * fetch where every token came back `'retry'`, the node is left alone for `retryBackoffMs`
 * (no calls, no sweep) so an outage costs one slow batch, not one per batch.
 */
export class MetadataLoader {
    private pausedUntil = 0

    constructor(
        private client: EthCallClient,
        private config: Pick<MetadataConfig, 'batchSize' | 'sweepLimit' | 'retryBackoffMs' | 'multicallAddress'>,
        private now: () => number = Date.now,
    ) {}

    private get paused(): boolean {
        return this.now() < this.pausedUntil
    }

    /** How many PENDING tokens the processor may backfill in this batch. */
    sweepLimit(): number {
        return this.paused ? 0 : this.config.sweepLimit
    }

    async fetch(tokens: string[]): Promise<Map<string, MetadataResult>> {
        if (this.paused) return new Map(tokens.map(t => [t, 'retry']))
        let results = await fetchTokenMetadata(this.client, tokens, {
            batchSize: this.config.batchSize,
            multicallAddress: this.config.multicallAddress,
        })
        if (results.size > 0 && [...results.values()].every(r => r === 'retry')) {
            this.pausedUntil = this.now() + this.config.retryBackoffMs
        }
        return results
    }
}
