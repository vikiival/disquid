import type {Block as RpcBlock, LatestBlockhash} from '@subsquid/evm-rpc'
import {createLogger} from '@subsquid/logger'
import {wait} from '@subsquid/util-internal'
import {
    BlockRef,
    BlockStream,
    DataSource,
    ForkException,
    isForkException,
    StreamRequest,
} from '@subsquid/util-internal-data-source'

export interface ForkWalkOptions {
    /** Walk at least this many parents unless an already streamed block is reached (default 64). */
    minDepth?: number
    /** Never walk more parents than this (default 512). */
    maxDepth?: number
}

/** What the ancestry walk needs from the RPC. */
export interface AncestryRpc {
    call<T = any>(method: string, params?: any[]): Promise<T>
    getLatestBlockhash(commitment: 'finalized'): Promise<LatestBlockhash>
}

const log = createLogger('sqd:rpc-fork')

// Enough to cover every unfinalized block of a stream (Ethereum keeps ~64-96).
const KNOWN_REFS = 2048

/**
 * evm-rpc throws `ForkException` with a single ref (the new parent), but the processor's
 * `findRollbackIndex` needs refs of the new chain overlapping its own heads to find the common
 * base, otherwise it throws "Unable to process fork". This wrapper rethrows it with the new
 * chain's ancestry (ascending), walked by parent hash.
 */
export class ForkSafeDataSource implements DataSource<RpcBlock> {
    private minDepth: number
    private maxDepth: number

    constructor(
        private inner: DataSource<RpcBlock>,
        private rpc: AncestryRpc,
        options: ForkWalkOptions = {},
    ) {
        this.minDepth = options.minDepth ?? 64
        this.maxDepth = Math.max(this.minDepth, options.maxDepth ?? 512)
    }

    getHead(): Promise<BlockRef> {
        return this.inner.getHead()
    }

    getFinalizedHead(): Promise<BlockRef> {
        return this.inner.getFinalizedHead()
    }

    getFinalizedStream(req: StreamRequest): BlockStream<RpcBlock> {
        return this.guard(this.inner.getFinalizedStream(req), req)
    }

    getStream(req: StreamRequest): BlockStream<RpcBlock> {
        return this.guard(this.inner.getStream(req), req)
    }

    private async *guard(stream: BlockStream<RpcBlock>, req: StreamRequest): BlockStream<RpcBlock> {
        // Refs this stream has handed out: the processor's heads are a subset of them.
        let known = new Map<number, string>()
        if (req.parentHash != null) known.set(req.from - 1, req.parentHash)
        let it = stream[Symbol.asyncIterator]()
        try {
            while (true) {
                let next
                try {
                    next = await it.next()
                } catch (err) {
                    if (isForkException(err)) throw await this.withAncestry(err, known)
                    throw err
                }
                if (next.done) return
                for (let block of next.value.blocks) {
                    known.set(block.number, block.hash)
                    if (known.size > KNOWN_REFS) known.delete(known.keys().next().value!)
                }
                yield next.value
            }
        } finally {
            await it.return?.()
        }
    }

    async withAncestry(err: ForkException, known: Map<number, string>): Promise<ForkException> {
        let top = err.previousBlocks[err.previousBlocks.length - 1]
        try {
            let refs = await this.walk(top, known)
            log.info(
                {forkBlock: top.number + 1, from: refs[0].number, to: top.number, refs: refs.length},
                'rebuilt the new chain ancestry for a fork',
            )
            return new ForkException(top.number + 1, err.expectedParentHash, refs)
        } catch (walkErr: any) {
            log.error(walkErr, 'failed to walk the new chain ancestry, rethrowing the original fork')
            return err
        }
    }

    /**
     * Walk the new chain down from `top` by parent hash until it meets a block this stream
     * already handed out (below that both chains agree, so the remaining known refs are
     * appended for free), or until it is at least `minDepth` deep and at or below the finalized
     * head, or `maxDepth` deep.
     */
    private async walk(top: BlockRef, known: Map<number, string>): Promise<BlockRef[]> {
        let finalized = await this.rpc.getLatestBlockhash('finalized')
        let chain: BlockRef[] = [top]
        let cur = top
        for (let depth = 0; ; depth++) {
            if (known.get(cur.number) === cur.hash) {
                let below = [...known].filter(([n]) => n < cur.number).sort((a, b) => b[0] - a[0])
                for (let [number, hash] of below) chain.push({number, hash})
                break
            }
            if (cur.number <= finalized.number && depth >= this.minDepth) break
            if (depth >= this.maxDepth || cur.number <= 0) break
            cur = {number: cur.number - 1, hash: await this.getParentHash(cur)}
            chain.push(cur)
        }
        return chain.reverse()
    }

    private async getParentHash(ref: BlockRef): Promise<string> {
        for (let attempt = 0; ; attempt++) {
            let block = await this.rpc.call<{number: string; hash: string; parentHash: string} | null>(
                'eth_getBlockByHash',
                [ref.hash, false],
            )
            if (block != null) {
                if (block.hash !== ref.hash || parseInt(block.number, 16) !== ref.number) {
                    throw new Error(`eth_getBlockByHash(${ref.hash}) returned block ${block.number}#${block.hash}`)
                }
                return block.parentHash
            }
            // A load-balanced node may not have the new fork yet.
            if (attempt >= 4) throw new Error(`block ${ref.number}#${ref.hash} not found`)
            await wait(500 * (attempt + 1))
        }
    }
}
