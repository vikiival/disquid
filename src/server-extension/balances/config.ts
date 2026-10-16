import {MULTICALL3_ADDRESS} from '../../rpc/multicall3'

/**
 * Starter list of mainnet tokens whose balances change without a Transfer event, so a cached
 * value can never be trusted. Extend it (or override per network) via BALANCE_ALWAYS_REFRESH_TOKENS.
 */
export const DEFAULT_ALWAYS_REFRESH_TOKENS = [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH: deposit()/withdraw() emit Deposit/Withdrawal
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH: rebasing shares
]

export interface BalanceConfig {
    rpcUrl?: string
    rpcRateLimit?: number
    rpcRequestTimeoutMs: number
    multicallAddress: string
    batchSize: number
    batchWindowMs: number
    concurrency: number
    maxQueuedBatches: number
    deadlineMs: number
    cacheSize: number
    cacheMaxAgeMs: number
    alwaysRefresh: Set<string>
}

export function balanceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BalanceConfig {
    let deadlineMs = envInt(env, 'BALANCE_DEADLINE_MS', 8000, 1)
    return {
        // A dedicated endpoint for the API is optional; the processor's RPC_URL is the fallback.
        rpcUrl: env.BALANCE_RPC_URL || env.RPC_URL || undefined,
        rpcRateLimit: env.BALANCE_RPC_RATE_LIMIT ? envInt(env, 'BALANCE_RPC_RATE_LIMIT', 0, 1) : undefined,
        rpcRequestTimeoutMs: envInt(env, 'BALANCE_RPC_TIMEOUT_MS', deadlineMs, 1),
        multicallAddress: (env.MULTICALL3_ADDRESS || MULTICALL3_ADDRESS).toLowerCase(),
        batchSize: envInt(env, 'BALANCE_BATCH_SIZE', 500, 1),
        batchWindowMs: envInt(env, 'BALANCE_BATCH_WINDOW_MS', 20, 0),
        concurrency: envInt(env, 'BALANCE_RPC_CONCURRENCY', 8, 1),
        maxQueuedBatches: envInt(env, 'BALANCE_RPC_QUEUE', 64, 0),
        deadlineMs,
        cacheSize: envInt(env, 'BALANCE_CACHE_SIZE', 200_000, 1),
        cacheMaxAgeMs: envInt(env, 'BALANCE_CACHE_MAX_AGE_MS', 3_600_000, 0),
        alwaysRefresh: new Set(
            env.BALANCE_ALWAYS_REFRESH_TOKENS == null
                ? DEFAULT_ALWAYS_REFRESH_TOKENS
                : env.BALANCE_ALWAYS_REFRESH_TOKENS.split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
        ),
    }
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
