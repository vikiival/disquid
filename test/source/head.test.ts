import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {MeteredRpcClient} from '../../src/source/client'
import {RpcCallMeter} from '../../src/source/metrics'
import {PushdownRpc, PushdownRpcOptions} from '../../src/source/pushdown-rpc'
import {FakeChain, FakeRpcServer, hashOf, TRANSFER} from './fake-rpc'

let server: FakeRpcServer
let meter: RpcCallMeter

function chainWithHeadAge(ageSeconds: number): FakeChain {
    let now = Math.floor(Date.now() / 1000)
    let chain = new FakeChain().extend(100, 139, 'a', (n) => now - ageSeconds - (139 - n) * 12)
    chain.finalized = 134
    return chain
}

async function start(chain: FakeChain) {
    server = await new FakeRpcServer(chain).start()
}

function makeRpc(options: Partial<PushdownRpcOptions> = {}): PushdownRpc {
    meter = new RpcCallMeter()
    let client = new MeteredRpcClient({url: server.url, retryAttempts: 3, retrySchedule: [5]}, meter)
    return new PushdownRpc({client, pushdown: true, logsFilter: {topic0: [TRANSFER]}, slotTime: 12, ...options})
}

afterEach(async () => {
    await server.stop()
})

describe('head-mode call pattern', () => {
    describe('fresh head', () => {
        beforeEach(() => start(chainWithHeadAge(1)))

        it('does not re-poll latest before the next slot is due', async () => {
            let rpc = makeRpc()
            for (let i = 0; i < 5; i++) {
                expect(await rpc.getLatestBlockhash('latest')).toEqual({number: 139, hash: hashOf('a', 139)})
            }
            expect(meter.counts.calls).toEqual({eth_getBlockByNumber: 1})
        })

        it('reuses the polled head header for the following block fetch', async () => {
            let rpc = makeRpc()
            await rpc.getLatestBlockhash('latest')
            let [block] = await rpc.getBlockBatch([139], {logs: true})
            expect(block.hash).toBe(hashOf('a', 139))
            expect(block.block.transactions).toEqual([])
            expect(block.logs!.map((l) => l.logIndex)).toEqual(['0x0', '0x2'])
            expect(server.callsOf('eth_getBlockByNumber').map((c) => c.params[0])).toEqual(['latest'])
            expect(server.callsOf('eth_getLogs')).toHaveLength(1)
        })
    })

    describe('missed slot', () => {
        beforeEach(() => start(chainWithHeadAge(20)))

        it('polls latest every time once the next block is overdue', async () => {
            let rpc = makeRpc()
            for (let i = 0; i < 3; i++) await rpc.getLatestBlockhash('latest')
            expect(meter.counts.calls['eth_getBlockByNumber']).toBe(3)
        })

        it('caches the finalized head', async () => {
            let rpc = makeRpc({finalizedHeadTtl: 60_000})
            let heads = await Promise.all([1, 2, 3].map(() => rpc.getLatestBlockhash('finalized')))
            heads.push(await rpc.getLatestBlockhash('finalized'))
            expect(heads.every((h) => h.number == 134)).toBe(true)
            expect(server.callsOf('eth_getBlockByNumber').map((c) => c.params[0])).toEqual(['finalized'])
        })

        it('probes only the highest finalized block for the finalizer', async () => {
            let rpc = makeRpc()
            let infos = await rpc.getFinalizedBlockBatch([130, 131, 132, 133, 134])
            expect(infos.map((b) => b?.hash ?? null)).toEqual([null, null, null, null, hashOf('a', 134)])
            // 134 is the finalized head itself: no header call.
            expect(server.callsOf('eth_getBlockByNumber').map((c) => c.params[0])).toEqual(['finalized'])

            infos = await rpc.getFinalizedBlockBatch([131, 132, 133, 135, 136])
            expect(infos.map((b) => b?.hash ?? null)).toEqual([null, null, hashOf('a', 133)])
            expect(server.callsOf('eth_getBlockByNumber').map((c) => c.params[0])).toEqual(['finalized', '0x85'])

            expect(await rpc.getFinalizedBlockBatch([135, 136])).toEqual([])
        })
    })
})
