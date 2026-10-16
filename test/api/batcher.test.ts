import {keccak256} from '@subsquid/evm-abi'
import {describe, expect, it} from 'vitest'
import {BalanceBatcher, type BatcherOptions} from '../../src/server-extension/balances/batcher'
import {aggregate3, MULTICALL3_ADDRESS} from '../../src/rpc/multicall3'
import {decodeBalanceOfBatch, encodeBalanceOfBatch} from '../../src/server-extension/balances/multicall3'
import {addr, deferred, encodeAggregate3Result, FakeMulticallNode, hash, uint256} from './fakes'

const OPTIONS: BatcherOptions = {batchSize: 500, windowMs: 5, concurrency: 8, maxQueuedBatches: 64}
const ALICE = addr(0xa11ce)
const BOB = addr(0xb0b)

function pairs(account: string, tokens: number[]) {
    return tokens.map(t => ({account, token: addr(t)}))
}

describe('multicall3 codec', () => {
    it('uses the aggregate3 selector', () => {
        let selector = '0x' + keccak256('aggregate3((address,bool,bytes)[])').toString('hex').slice(0, 8)
        expect(aggregate3.selector).toBe(selector)
    })

    it('encodes balanceOf calls with allowFailure and decodes per-call results', () => {
        let data = encodeBalanceOfBatch([{account: ALICE, token: addr(1)}])
        let {calls} = aggregate3.decode(data)
        expect(calls).toEqual([{target: addr(1), allowFailure: true, callData: '0x70a08231' + ALICE.slice(2).padStart(64, '0')}])

        let output = encodeAggregate3Result([
            {success: true, returnData: uint256(42n)},
            {success: false, returnData: '0x'},
            {success: true, returnData: '0x'},
            {success: true, returnData: '0x1234'},
        ])
        expect(decodeBalanceOfBatch(output, 4)).toEqual([42n, undefined, undefined, undefined])
        expect(() => decodeBalanceOfBatch(output, 3)).toThrow()
    })
})

describe('BalanceBatcher', () => {
    it('coalesces concurrent requests at the same block hash into one aggregate3 call', async () => {
        let node = new FakeMulticallNode((token, account) => BigInt(parseInt(token, 16)) + (account === BOB ? 1000n : 0n))
        let batcher = new BalanceBatcher(node, OPTIONS)
        let [a, b] = await Promise.all([
            batcher.load(hash(1), pairs(ALICE, [1, 2]), 1000),
            batcher.load(hash(1), pairs(BOB, [1, 3]), 1000),
        ])
        expect(a).toEqual([{balance: 1n}, {balance: 2n}])
        expect(b).toEqual([{balance: 1001n}, {balance: 1003n}])
        expect(node.calls).toHaveLength(1)
        expect(node.calls[0]).toMatchObject({to: MULTICALL3_ADDRESS, blockHash: hash(1)})
        expect(node.calls[0].pairs).toHaveLength(4)
    })

    it('keeps different block hashes in separate calls', async () => {
        let node = new FakeMulticallNode()
        let batcher = new BalanceBatcher(node, OPTIONS)
        await Promise.all([
            batcher.load(hash(1), pairs(ALICE, [1]), 1000),
            batcher.load(hash(2), pairs(ALICE, [1]), 1000),
        ])
        expect(node.calls.map(c => c.blockHash).sort()).toEqual([hash(1), hash(2)])
    })

    it('single-flights identical (blockHash, account, token) reads', async () => {
        let node = new FakeMulticallNode(() => 7n)
        let batcher = new BalanceBatcher(node, OPTIONS)
        let results = await Promise.all([1, 2, 3].map(() => batcher.load(hash(1), pairs(ALICE, [1]), 1000)))
        expect(results).toEqual([[{balance: 7n}], [{balance: 7n}], [{balance: 7n}]])
        expect(node.calls).toHaveLength(1)
        expect(node.calls[0].pairs).toHaveLength(1)
        expect(batcher.stats.deduped).toBe(2)
    })

    it('flushes at batchSize without waiting for the window', async () => {
        let node = new FakeMulticallNode()
        let batcher = new BalanceBatcher(node, {...OPTIONS, batchSize: 3, windowMs: 60_000})
        let started = Date.now()
        let result = await batcher.load(hash(1), pairs(ALICE, [1, 2, 3, 4, 5, 6]), 5000)
        expect(Date.now() - started).toBeLessThan(1000)
        expect(result.every(r => r.balance === 1n)).toBe(true)
        expect(node.calls.map(c => c.pairs.length)).toEqual([3, 3])
    })

    it('maps per-call failures to CALL_FAILED and node failures to RPC_ERROR', async () => {
        let node = new FakeMulticallNode(token => (token === addr(2) ? 'revert' : token === addr(3) ? 'empty' : 5n))
        let batcher = new BalanceBatcher(node, OPTIONS)
        expect(await batcher.load(hash(1), pairs(ALICE, [1, 2, 3]), 1000)).toEqual([
            {balance: 5n},
            {error: 'CALL_FAILED'},
            {error: 'CALL_FAILED'},
        ])

        node.fail = new Error('boom')
        expect(await batcher.load(hash(2), pairs(ALICE, [1, 2]), 1000)).toEqual([{error: 'RPC_ERROR'}, {error: 'RPC_ERROR'}])
        expect(batcher.stats.rpcErrors).toBe(1)

        // A failed read is not remembered: the next request tries again.
        node.fail = undefined
        expect(await batcher.load(hash(2), pairs(ALICE, [1]), 1000)).toEqual([{balance: 5n}])
    })

    it('bounds concurrency and answers RPC_BUSY once the queue is full', async () => {
        let node = new FakeMulticallNode()
        let gate = deferred()
        node.gate = gate.promise
        let batcher = new BalanceBatcher(node, {...OPTIONS, batchSize: 1, concurrency: 2, maxQueuedBatches: 1})

        // 2 running + 1 queued fit; the 4th batch has no room.
        let pending = batcher.load(hash(1), pairs(ALICE, [1, 2, 3]), 5000)
        let rejected = await batcher.load(hash(1), pairs(ALICE, [4]), 5000)
        expect(rejected).toEqual([{error: 'RPC_BUSY'}])
        expect(node.inFlight).toBe(2)

        gate.resolve()
        expect(await pending).toEqual([{balance: 1n}, {balance: 1n}, {balance: 1n}])
        expect(node.maxInFlight).toBe(2)
        expect(node.calls).toHaveLength(3)
        expect(batcher.stats.busy).toBe(1)
    })

    it('answers RPC_TIMEOUT at the deadline and skips batches nobody waits for any more', async () => {
        let node = new FakeMulticallNode()
        let gate = deferred()
        node.gate = gate.promise
        let batcher = new BalanceBatcher(node, {...OPTIONS, batchSize: 1, concurrency: 1})

        let result = await batcher.load(hash(1), pairs(ALICE, [1, 2]), 30)
        expect(result).toEqual([{error: 'RPC_TIMEOUT'}, {error: 'RPC_TIMEOUT'}])
        expect(batcher.stats.timeouts).toBe(2)

        gate.resolve()
        await new Promise(r => setTimeout(r, 10))
        // The first call was already in flight; the queued second one expired and was dropped.
        expect(node.calls).toHaveLength(1)

        // The single-flight entry is gone, so a later request reads again.
        expect(await batcher.load(hash(1), pairs(ALICE, [2]), 1000)).toEqual([{balance: 1n}])
    })
})
