import {EvmRpcDataSource} from '@subsquid/evm-rpc'
import type {FieldSelection} from '@subsquid/evm-stream'
import {EvmRpcStreamDataSource, type EvmRpcStreamOptions} from '@subsquid/squid-sdk/evm/rpc'
import assert from 'assert'

import {LogsCatchupDataSource, type LogsCatchupOptions} from './catchup'
import {ForkSafeDataSource, ForkWalkOptions} from './fork'
import {RpcCallMeter} from './metrics'
import {PushdownRpc} from './pushdown-rpc'

export interface DiscoveryRpcStreamOptions<F extends FieldSelection> extends EvmRpcStreamOptions<F> {
    rpc: PushdownRpc
    /** Fetch blocks without transaction objects (the request needs only headers and logs). */
    headerOnly: boolean
    headPollInterval: number
    fork?: ForkWalkOptions
    /** Serve finalized gaps from `eth_getLogs` alone, without per-block headers. */
    catchup?: LogsCatchupOptions
    meter: RpcCallMeter
}

/**
 * The stock RPC stream data source with its inner evm-rpc source swapped: the stock one
 * always asks for full transactions and polls the head every 100 ms, and neither is
 * configurable. Decoding, client-side filtering and projection stay the SDK's.
 */
export class DiscoveryRpcStreamDataSource<F extends FieldSelection> extends EvmRpcStreamDataSource<F> {
    readonly rpc: PushdownRpc
    readonly meter: RpcCallMeter

    constructor(options: DiscoveryRpcStreamOptions<F>) {
        super(options)
        this.rpc = options.rpc
        this.meter = options.meter
        let stock: EvmRpcDataSource = (this as any).inner
        assert(stock instanceof Object && stock.req != null, 'unexpected EvmRpcStreamDataSource internals')
        let inner = new EvmRpcDataSource({
            rpc: options.rpc,
            req: {...stock.req, transactions: options.headerOnly ? false : stock.req.transactions},
            strideSize: options.strideSize,
            strideConcurrency: options.strideConcurrency,
            headPollInterval: options.headPollInterval,
        })
        let source = options.catchup ? new LogsCatchupDataSource(inner, options.rpc, options.catchup) : inner
        ;(this as any).inner = new ForkSafeDataSource(source, options.rpc, options.fork)
    }
}
