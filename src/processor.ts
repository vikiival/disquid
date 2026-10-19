import 'dotenv/config'

import {assertNotNull} from '@subsquid/util-internal'

import {DiscoveryRpcSourceBuilder} from './source'
import {topic0Union} from './standards'

export const START_BLOCK = Number(process.env.START_BLOCK ?? 26_104_555)

function intFromEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback)
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
    return value
}

// DiscoveryRpcSourceBuilder is EvmRpcDataSourceBuilder plus header-only blocks, topic-filtered
// eth_getLogs, header-less finalized catch-up, retries/timeouts, slot-aware head polling and a
// reorg fix (see src/source).
export const source = new DiscoveryRpcSourceBuilder()
    .setRpc({
        url: assertNotNull(process.env.RPC_URL, 'RPC_URL is required'),
        network: 'ethereum-mainnet',
        rateLimit: intFromEnv('RPC_RATE_LIMIT', 50),
        capacity: intFromEnv('RPC_CAPACITY', 10),
        maxBatchCallSize: intFromEnv('RPC_MAX_BATCH_CALL_SIZE', 50),
        strideSize: intFromEnv('RPC_STRIDE_SIZE', 50),
        strideConcurrency: intFromEnv('RPC_STRIDE_CONCURRENCY', 4),
        maxLogsRange: intFromEnv('RPC_MAX_LOGS_RANGE', 100),
        headPollInterval: intFromEnv('RPC_HEAD_POLL_INTERVAL_MS', 2000),
    })
    .setFields({
        block: {timestamp: true},
        log: {address: true, topics: true, data: true},
    })
    // Every header is stored (Block rows), including blocks without token events.
    .includeAllBlocks({from: START_BLOCK})
    .addLog({
        where: {topic0: topic0Union()},
        range: {from: START_BLOCK},
    })
    .build()
