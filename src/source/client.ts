import {EvmRpcClient, EvmRpcClientOptions} from '@subsquid/evm-rpc'
import assert from 'assert'

import {RpcCallMeter} from './metrics'

interface RpcRequestLike {
    method: string
}

interface ConnectionLike {
    call(req: RpcRequestLike, timeout?: number): Promise<unknown>
    batchCall(batch: RpcRequestLike[], timeout?: number): Promise<unknown>
}

/**
 * `EvmRpcClient` that meters every request it actually sends. The transport is private in
 * rpc-client, so it is wrapped after construction; counting there (rather than in `call` /
 * `batchCall`) includes retries and avoids double counting single-item batches.
 */
export class MeteredRpcClient extends EvmRpcClient {
    constructor(
        options: EvmRpcClientOptions,
        readonly meter: RpcCallMeter,
    ) {
        super(options)
        let con: ConnectionLike = (this as any).con
        assert(con && typeof con.call == 'function' && typeof con.batchCall == 'function', 'unexpected rpc-client internals')
        let call = con.call.bind(con)
        let batchCall = con.batchCall.bind(con)
        con.call = (req, timeout) => this.metered([req.method], call(req, timeout))
        con.batchCall = (batch, timeout) => this.metered(batch.map((r) => r.method), batchCall(batch, timeout))
    }

    private metered<T>(methods: string[], promise: Promise<T>): Promise<T> {
        this.meter.recordRequest(methods)
        return promise.catch((err) => {
            this.meter.recordError(methods)
            throw err
        })
    }
}
