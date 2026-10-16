import {findRollbackIndex, HashAndHeight, HotDatabase, HotTxInfo, Processor} from '@subsquid/batch-processor'
import type {Block as RpcBlock} from '@subsquid/evm-rpc'
import {EvmRpcDataSourceBuilder} from '@subsquid/squid-sdk/evm/rpc'
import {BlockRef, BlockStream, DataSource, ForkException, StreamRequest} from '@subsquid/util-internal-data-source'
import {afterEach, describe, expect, it} from 'vitest'

import {DiscoveryRpcSourceBuilder} from '../../src/source'
import {ForkSafeDataSource} from '../../src/source/fork'
import {FakeChain, FakeRpcServer, hashOf, TRANSFER} from './fake-rpc'

const ref = (tag: string, n: number): BlockRef => ({number: n, hash: hashOf(tag, n)})

/** Old chain ...100, 101, 102a, 103a; new chain 101 <- 102b <- 103b <- 104b. Finalized 100. */
function forkedChain(): FakeChain {
    // 102a and 103a stay known by hash, as orphans do on a real node.
    let chain = new FakeChain().extend(30, 103, 'a').extend(102, 104, 'b')
    chain.finalized = 100
    return chain
}

class ScriptedSource implements DataSource<RpcBlock> {
    constructor(
        private batches: BlockRef[][],
        private fork: ForkException,
    ) {}
    async getHead() {
        return ref('b', 104)
    }
    async getFinalizedHead() {
        return ref('a', 100)
    }
    getFinalizedStream(req: StreamRequest): BlockStream<RpcBlock> {
        return this.getStream(req)
    }
    async *getStream(_req?: StreamRequest): BlockStream<RpcBlock> {
        for (let refs of this.batches) {
            yield {blocks: refs.map((r) => ({...r, block: {} as any}))}
        }
        throw this.fork
    }
}

function ancestryRpc(chain: FakeChain) {
    let server = new FakeRpcServer(chain)
    let calls = 0
    return {
        get calls() {
            return calls
        },
        async call(method: string, params?: any[]): Promise<any> {
            calls += 1
            return server.handle({method, params: params ?? []})
        },
        async getLatestBlockhash() {
            return ref('a', chain.finalized)
        },
    }
}

async function drain(stream: BlockStream<RpcBlock>): Promise<unknown> {
    try {
        for await (let _ of stream) {
        }
    } catch (err) {
        return err
    }
    throw new Error('stream ended without a fork')
}

describe('fork ancestry', () => {
    // What evm-rpc's ensureContinuity throws when 104b arrives after 103a.
    const stockFork = () => new ForkException(104, hashOf('a', 103), [ref('b', 103)])

    it('the stock single-ref exception cannot be resolved by findRollbackIndex', () => {
        let processorChain = [ref('a', 100), ref('a', 101), ref('a', 102), ref('a', 103)]
        expect(findRollbackIndex(processorChain, stockFork().previousBlocks)).toBe(-1)
    })

    it('rethrows with the new chain ancestry down to an already streamed block', async () => {
        let rpc = ancestryRpc(forkedChain())
        let inner = new ScriptedSource([[ref('a', 101)], [ref('a', 102), ref('a', 103)]], stockFork())
        let source = new ForkSafeDataSource(inner, rpc)
        let err = (await drain(source.getStream({from: 101, parentHash: hashOf('a', 100)}))) as ForkException

        expect(err.isSqdForkException).toBe(true)
        expect(err.previousBlocks).toEqual([ref('a', 100), ref('a', 101), ref('b', 102), ref('b', 103)])
        // Parents of 103b and 102b only; 101 and below come from what the stream handed out.
        expect(rpc.calls).toBe(2)

        // ProcessorState.handleFork: chain = [finalizedHead, ...unfinalizedHeads].
        let processorChain = [ref('a', 100), ref('a', 101), ref('a', 102), ref('a', 103)]
        let idx = findRollbackIndex(processorChain, err.previousBlocks)
        expect(processorChain[idx]).toEqual(ref('a', 101))
        // Sparse heads (one per batch) still find a common base.
        let sparse = [ref('a', 100), ref('a', 101), ref('a', 103)]
        expect(sparse[findRollbackIndex(sparse, err.previousBlocks)]).toEqual(ref('a', 101))
    })

    it('walks below the finalized head when the fork predates the stream', async () => {
        let rpc = ancestryRpc(forkedChain())
        // A restarted stream: the processor's head 103a is all it knows.
        let inner = new ScriptedSource([], stockFork())
        let source = new ForkSafeDataSource(inner, rpc, {minDepth: 10})
        let err = (await drain(source.getStream({from: 104, parentHash: hashOf('a', 103)}))) as ForkException

        let refs = err.previousBlocks
        expect(refs.at(-1)).toEqual(ref('b', 103))
        expect(refs[0].number).toBeLessThanOrEqual(100)
        expect(refs).toHaveLength(11)
        for (let i = 1; i < refs.length; i++) expect(refs[i].number).toBe(refs[i - 1].number + 1)

        let processorChain = [ref('a', 95), ref('a', 99), ref('a', 103)]
        expect(processorChain[findRollbackIndex(processorChain, refs)]).toEqual(ref('a', 99))
    })
})

class MemoryHotDatabase implements HotDatabase<{}> {
    readonly supportsHotBlocks = true
    chain: HashAndHeight[]
    rollbacks: HashAndHeight[] = []

    constructor(head: HashAndHeight) {
        this.chain = [head]
    }

    async connect() {
        return {...this.chain[0], top: []}
    }

    async transact(): Promise<void> {
        throw new Error('not used')
    }

    async transactHot2(info: HotTxInfo, cb: (store: {}, beg: number, end: number) => Promise<unknown>) {
        let pos = this.chain.findIndex((b) => b.hash === info.baseHead.hash)
        if (pos < 0) throw new Error(`unknown base ${info.baseHead.height}#${info.baseHead.hash}`)
        if (pos < this.chain.length - 1) this.rollbacks.push(info.baseHead)
        this.chain = [...this.chain.slice(0, pos + 1), ...info.newBlocks]
        await cb({}, 0, info.newBlocks.length)
    }
}

describe('reorg at the head through the real batch-processor', () => {
    let server: FakeRpcServer | undefined

    afterEach(async () => {
        await server?.stop()
        server = undefined
    })

    async function runProcessor(build: (url: string) => DataSource<any>) {
        let chain = new FakeChain().extend(90, 101, 'a')
        chain.finalized = 100
        server = await new FakeRpcServer(chain).start()
        let db = new MemoryHotDatabase({height: 100, hash: hashOf('a', 100)})
        let seen: string[] = []
        let processor = new Processor(build(server.url), db, async (ctx) => {
            for (let b of ctx.blocks) {
                seen.push(`${b.header.number}${b.header.hash == hashOf('a', b.header.number) ? 'a' : 'b'}`)
                // Two head batches (101a, then 102a..103a); the reorg follows once 103a is processed.
                if (b.header.hash == hashOf('a', 101)) chain.extend(102, 103, 'a')
                if (b.header.hash == hashOf('a', 103)) chain.extend(102, 106, 'b')
            }
        })
        let result = await processor.run().then(
            () => undefined,
            (err: Error) => err,
        )
        return {result, db, seen}
    }

    const LOGS = {where: {topic0: [TRANSFER]}, range: {from: 101, to: 106}}

    it('stock EvmRpcDataSourceBuilder crashes with "Unable to process fork"', async () => {
        let {result, seen} = await runProcessor((url) =>
            new EvmRpcDataSourceBuilder()
                .setRpc({url, rpc: {verifyBlockHash: false}})
                .setFields({log: {topics: true}})
                .addLog(LOGS)
                .build(),
        )
        expect(seen).toContain('103a')
        expect(result?.message).toBe('Unable to process fork')
    }, 20_000)

    it('DiscoveryRpcSourceBuilder rolls back to the common base and continues', async () => {
        let {result, db, seen} = await runProcessor((url) =>
            new DiscoveryRpcSourceBuilder()
                .setRpc({url, rpc: {verifyBlockHash: false}, headPollInterval: 20, finalizedHeadTtl: 0, metricsInterval: 0})
                .setFields({log: {topics: true}})
                .addLog(LOGS)
                .build(),
        )
        expect(result).toBeUndefined()
        expect(seen.slice(seen.indexOf('103a') + 1)).toEqual(['102b', '103b', '104b', '105b', '106b'])
        expect(db.rollbacks).toEqual([{height: 101, hash: hashOf('a', 101)}])
        expect(db.chain.at(-1)).toEqual({height: 106, hash: hashOf('b', 106)})
    }, 20_000)
})
