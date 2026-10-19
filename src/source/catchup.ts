import type {Block as RpcBlock} from '@subsquid/evm-rpc'
import {createLogger} from '@subsquid/logger'
import {concurrentMap, wait} from '@subsquid/util-internal'
import {BlockRef, BlockStream, DataSource, StreamRequest} from '@subsquid/util-internal-data-source'
import {type FiniteRange, splitRange} from '@subsquid/util-internal-range'

import type {PushdownRpc} from './pushdown-rpc'

export interface LogsCatchupOptions {
    /** Blocks per `eth_getLogs` job. Shorter gaps to the finalized head go the normal way. */
    range: number
    /** Blocks per yielded batch, i.e. per processor transaction. */
    batchSize: number
    /** Jobs in flight. */
    concurrency: number
    /** Attempts per job before the stream fails (default 5). */
    attempts?: number
}

const log = createLogger('sqd:rpc-catchup')
const PAUSES = [500, 2000, 5000, 10000]

/**
 * Serves the finalized part of a stream from filtered `eth_getLogs` alone (see
 * `PushdownRpc.getLogsOnlyBlocks`), without one header call per block, then hands over to the
 * inner stream at the first block of the remaining gap, with the hash of the block before it as
 * `parentHash`, so the inner stream's continuity check ties the two together.
 *
 * Finalized blocks cannot fork, so `parentHash` of a block built from logs is set to the hash of
 * the block streamed before it rather than read from a header.
 */
export class LogsCatchupDataSource implements DataSource<RpcBlock> {
    constructor(
        private inner: DataSource<RpcBlock>,
        private rpc: PushdownRpc,
        private options: LogsCatchupOptions,
    ) {}

    getHead(): Promise<BlockRef> {
        return this.inner.getHead()
    }

    getFinalizedHead(): Promise<BlockRef> {
        return this.inner.getFinalizedHead()
    }

    getFinalizedStream(req: StreamRequest): BlockStream<RpcBlock> {
        return this.stream(req, (rest) => this.inner.getFinalizedStream(rest))
    }

    getStream(req: StreamRequest): BlockStream<RpcBlock> {
        return this.stream(req, (rest) => this.inner.getStream(rest))
    }

    private async *stream(
        req: StreamRequest,
        next: (req: StreamRequest) => BlockStream<RpcBlock>,
    ): BlockStream<RpcBlock> {
        let {range, batchSize, concurrency} = this.options
        let from = req.from
        let to = req.to ?? Infinity
        let parentHash = req.parentHash
        while (from <= to) {
            let finalized = await this.rpc.getLatestBlockhash('finalized')
            let end = Math.min(finalized.number, to)
            if (end - from + 1 < range) break
            if (from === req.from) {
                // The caller's head may be a hot block that was replaced while it was away. The
                // inner stream turns that mismatch into the fork the processor rolls back.
                let actual = await this.parentHashOf(from)
                if (parentHash != null && parentHash !== actual) break
                parentHash = actual
            }
            log.info({from, to: end}, 'finalized catch-up from eth_getLogs')
            let jobs = concurrentMap(concurrency, splitRange(range, {from, to: end}), (r) => this.fetch(r))
            for await (let blocks of jobs) {
                for (let block of blocks) {
                    if (block.block.parentHash === '') {
                        block.block.parentHash = parentHash!
                    } else if (block.block.parentHash !== parentHash) {
                        // A fetched header that does not extend the streamed chain: a stale node.
                        throw new Error(`finalized block ${block.number}#${block.hash} does not extend ${parentHash}`)
                    }
                    parentHash = block.hash
                }
                for (let i = 0; i < blocks.length; i += batchSize) {
                    yield {blocks: blocks.slice(i, i + batchSize), finalizedHead: finalized}
                }
            }
            from = end + 1
        }
        if (from > to) return
        yield* next({...req, from, parentHash})
    }

    private async fetch(range: FiniteRange): Promise<RpcBlock[]> {
        let attempts = this.options.attempts ?? 5
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.rpc.getLogsOnlyBlocks(range.from, range.to)
            } catch (err: any) {
                if (attempt >= attempts) throw err
                let pause = PAUSES[Math.min(attempt - 1, PAUSES.length - 1)]
                log.warn({fromBlock: range.from, toBlock: range.to, reason: err.message, attempt, pause}, 'logs-only range failed, retrying')
                await wait(pause)
            }
        }
    }

    private async parentHashOf(number: number): Promise<string> {
        let [block] = await this.rpc.getBlockBatch([number])
        if (block == null) throw new Error(`node returned no header for block ${number}`)
        return block.block.parentHash
    }
}
