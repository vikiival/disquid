import type {FieldSelection} from '@subsquid/evm-stream'
import {createLogger} from '@subsquid/logger'
import {
    EvmRpcDataSourceBuilder,
    type EvmRpcOptions,
    flattenRequest,
    getNetworkPreset,
    resolveNetworkSettings,
} from '@subsquid/squid-sdk/evm/rpc'
import assert from 'assert'

import {MeteredRpcClient} from './client'
import {DiscoveryRpcStreamDataSource} from './data-source'
import {ForkWalkOptions} from './fork'
import {RpcCallMeter} from './metrics'
import {PushdownRpc} from './pushdown-rpc'
import {deriveLogsFilter, needsTransactions} from './request'

const log = createLogger('sqd:evm-rpc')

// Post-merge slot times; head polls are skipped until the next slot is due.
const SLOT_TIMES: Record<string, number> = {'ethereum-mainnet': 12, '1': 12}

export interface DiscoveryRpcOptions extends EvmRpcOptions {
    /** Client retries on connection errors, 429s and timeouts (default: unbounded, with back-off). */
    retryAttempts?: number
    /** Back-off pauses in ms (default rpc-client's `[10, 100, 500, 2000, 10000, 20000]`). */
    retrySchedule?: number[]
    /** Per-request timeout in ms (default 30 000; rpc-client's default is none). */
    requestTimeout?: number
    /** Max calls per JSON-RPC batch. rpc-client also caps it at `rateLimit / 5` when `rateLimit` is set. */
    maxBatchCallSize?: number
    /** Retry HTTP 500 / -32000 / -32603 (default true: load-balanced providers return them transiently). */
    retryInternalServerErrors?: boolean
    /**
     * Pause between head polls once caught up, in ms. Default 2 000 when the slot time is known
     * (polls only run after the next slot is due), else 3 000.
     */
    headPollInterval?: number
    /** Chain slot time in seconds; 0 disables slot-gated head polling. Default 12 on Ethereum. */
    slotTime?: number
    /**
     * Header-only blocks plus `eth_getLogs` filtered by the requested topic0/addresses when the
     * request needs nothing but headers and logs (default true). Client-side filtering stays.
     */
    logsPushdown?: boolean
    /** Max blocks per `eth_getLogs` call (default: one stride). */
    maxLogsRange?: number
    /** Reuse of the `finalized` head in ms (default 60 000). */
    finalizedHeadTtl?: number
    /** Re-fetch blocks whose filtered logs are empty while the header bloom admits a match (default true). */
    checkEmptyBlocksBloom?: boolean
    /** Fork ancestry walk bounds. */
    fork?: ForkWalkOptions
    /** Period of the `sqd:rpc-cost` summary in ms; 0 disables it (default 60 000). */
    metricsInterval?: number
}

/**
 * `EvmRpcDataSourceBuilder` with the RPC layer assembled here instead of in the SDK: retries,
 * timeouts, logs pushdown, slot-gated head polling, a reorg-safe `ForkException` and call
 * metering. Same fluent API; `setRpc` takes {@link DiscoveryRpcOptions}.
 */
export class DiscoveryRpcSourceBuilder<F extends FieldSelection = {}> extends EvmRpcDataSourceBuilder<F> {
    private rpcOptions?: DiscoveryRpcOptions

    setRpc(options: string | DiscoveryRpcOptions): this {
        this.rpcOptions = typeof options == 'string' ? {url: options} : options
        super.setRpc(options)
        return this
    }

    setFields<T extends FieldSelection>(fields: T): DiscoveryRpcSourceBuilder<T> {
        super.setFields(fields)
        return this as unknown as DiscoveryRpcSourceBuilder<T>
    }

    build(): DiscoveryRpcStreamDataSource<F> {
        let o = this.rpcOptions
        assert(o, 'RPC endpoint not set — call setRpc(...)')
        let fields = this.fields as F
        let requests = this.getRequests()
        let flat = requests.map((r) => flattenRequest(r.request))

        if (o.network == null || getNetworkPreset(o.network) == null) {
            if (o.rpc == null && o.method == null) {
                log.warn('RPC source without a known network preset or rpc overrides: block validation is disabled')
            }
        }
        let settings = resolveNetworkSettings(o.network, {rpc: o.rpc, method: o.method})
        let headerOnly = (o.logsPushdown ?? true) && !needsTransactions(flat, fields)
        let slotTime = o.slotTime ?? (o.network == null ? 0 : (SLOT_TIMES[String(o.network)] ?? 0))
        let retryAttempts = o.retryAttempts ?? Number.MAX_SAFE_INTEGER

        let meter = new RpcCallMeter()
        let client = new MeteredRpcClient(
            {
                url: o.url,
                capacity: o.capacity,
                rateLimit: o.rateLimit,
                requestTimeout: o.requestTimeout ?? 30_000,
                retryAttempts,
                retrySchedule: o.retrySchedule,
                maxBatchCallSize: o.maxBatchCallSize,
                retryInternalServerErrors: o.retryInternalServerErrors ?? true,
            },
            meter,
        )
        let rpc = new PushdownRpc({
            client,
            ...settings.rpc,
            pushdown: headerOnly,
            logsFilter: headerOnly ? deriveLogsFilter(flat) : undefined,
            maxLogsRange: o.maxLogsRange,
            retryAttempts,
            retrySchedule: o.retrySchedule,
            finalizedHeadTtl: o.finalizedHeadTtl,
            slotTime,
            checkEmptyBlocksBloom: o.checkEmptyBlocksBloom,
        })
        meter.startReporting(o.metricsInterval ?? 60_000)

        return new DiscoveryRpcStreamDataSource<F>({
            rpc,
            fields,
            requests,
            method: settings.method,
            strideSize: o.strideSize,
            strideConcurrency: o.strideConcurrency,
            headerOnly,
            headPollInterval: o.headPollInterval ?? (slotTime > 0 ? 2_000 : 3_000),
            fork: o.fork,
            meter,
        })
    }
}
