import type {Block} from '@subsquid/evm-stream'
import type {DataSource} from '@subsquid/util-internal-data-source'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {DiscoveryRpcSourceBuilder} from '../../src/source'
import {APPROVAL, FakeChain, FakeRpcServer, hashOf, headerJson, makeBlock, span, TOKEN_A, TOKEN_B, TRANSFER} from './fake-rpc'

const FIELDS = {
    block: {timestamp: true},
    log: {address: true, topics: true, data: true, transactionHash: true},
} as const

let server: FakeRpcServer

beforeEach(async () => {
    let chain = new FakeChain().extend(100, 139, 'a')
    chain.finalized = 139
    server = await new FakeRpcServer(chain).start()
})

afterEach(async () => {
    await server.stop()
})

function build(options: {strideSize?: number; maxLogsRange?: number} = {}) {
    return new DiscoveryRpcSourceBuilder()
        .setRpc({
            url: server.url,
            rpc: {verifyBlockHash: false},
            strideSize: options.strideSize ?? 10,
            strideConcurrency: 1,
            maxLogsRange: options.maxLogsRange,
            retrySchedule: [5],
            metricsInterval: 0,
        })
        .setFields(FIELDS)
        .addLog({where: {topic0: [TRANSFER]}, range: {from: 100, to: 139}})
        .build()
}

type Out = Block<typeof FIELDS>

// The built source keeps the block type inferred from setFields (what run() hands to handlers).
const _typed: () => DataSource<Out> = () => build()

async function collect(source: ReturnType<typeof build>, from = 100, to = 139): Promise<Out[]> {
    let blocks: Out[] = []
    for await (let batch of source.getFinalizedStream({from, to})) blocks.push(...batch.blocks)
    return blocks
}

function expectTransfers(blocks: Out[], from = 100, to = 139) {
    expect(blocks.map((b) => b.header.number)).toEqual(Array.from({length: to - from + 1}, (_, i) => from + i))
    for (let b of blocks) {
        let src = makeBlock(b.header.number, 'a', '')
        expect(b.header.hash).toBe(hashOf('a', b.header.number))
        expect(b.header.timestamp).toBe(src.timestamp * 1000)
        expect(b.logs.map((l) => [l.logIndex, l.address, l.topics[0], l.transactionHash, l.data])).toEqual([
            [0, TOKEN_A, TRANSFER, src.txHashes[0], src.logs[0].data],
            [2, TOKEN_B, TRANSFER, src.txHashes[1], src.logs[2].data],
        ])
        expect(b.transactions).toEqual([])
    }
}

describe('logs pushdown', () => {
    it('fetches header-only blocks and pushes topic0 into eth_getLogs', async () => {
        let source = build()
        let blocks = await collect(source)
        expectTransfers(blocks)

        let byNumber = server.callsOf('eth_getBlockByNumber').filter((c) => /^0x[0-9a-f]+$/.test(c.params[0]))
        expect(byNumber).toHaveLength(40)
        expect(byNumber.every((c) => c.params[1] === false)).toBe(true)

        let getLogs = server.callsOf('eth_getLogs')
        expect(getLogs).toHaveLength(4)
        for (let c of getLogs) {
            expect(c.params[0].topics).toEqual([[TRANSFER]])
            expect(c.params[0].address).toBeUndefined()
            expect(span(c)).toBe(10)
        }
        // Approval logs reach the node filter's superset only if requested; they are not.
        expect(blocks.flatMap((b) => b.logs).some((l) => l.topics[0] == APPROVAL)).toBe(false)

        let counts = source.meter.counts
        expect(counts.calls['eth_getLogs']).toBe(4)
        expect(counts.calls['eth_getBlockByNumber']).toBe(server.callsOf('eth_getBlockByNumber').length)
    })

    it('pushes the address union when every log request has one', async () => {
        let source = new DiscoveryRpcSourceBuilder()
            .setRpc({url: server.url, rpc: {verifyBlockHash: false}, strideSize: 40, metricsInterval: 0})
            .setFields(FIELDS)
            .addLog({where: {topic0: [TRANSFER], address: [TOKEN_B]}, range: {from: 100, to: 139}})
            .addLog({where: {topic0: [APPROVAL], address: [TOKEN_A]}, range: {from: 120, to: 139}})
            .build()
        let blocks = await collect(source)
        let [call] = server.callsOf('eth_getLogs')
        expect(call.params[0].topics).toEqual([[APPROVAL, TRANSFER].sort()])
        expect(call.params[0].address).toEqual([TOKEN_A, TOKEN_B])
        // The client-side filter still applies each request to its own range.
        expect(blocks.find((b) => b.header.number == 110)!.logs.map((l) => l.logIndex)).toEqual([2])
        expect(blocks.find((b) => b.header.number == 130)!.logs.map((l) => l.logIndex)).toEqual([1, 2])
    })

    it('fetches full blocks when transactions are requested', async () => {
        let source = new DiscoveryRpcSourceBuilder()
            .setRpc({url: server.url, rpc: {verifyBlockHash: false}, strideSize: 40, metricsInterval: 0})
            .setFields({...FIELDS, transaction: {hash: true}})
            .addLog({where: {topic0: [TRANSFER]}, include: {transaction: true}, range: {from: 100, to: 109}})
            .build()
        await collect(source as any, 100, 109)
        let byNumber = server.callsOf('eth_getBlockByNumber').filter((c) => /^0x[0-9a-f]+$/.test(c.params[0]))
        expect(byNumber.every((c) => c.params[1] === true)).toBe(true)
        expect(server.callsOf('eth_getLogs').every((c) => c.params[0].topics == null)).toBe(true)
    })

    it('bisects ranges the provider refuses', async () => {
        server.hooks.push((call) => {
            if (call.method == 'eth_getLogs' && call.params[0].fromBlock && span(call) > 3) {
                // Infura's wording and code; EvmRpcClient would treat -32005 as a rate limit.
                return {error: {code: -32005, message: 'query returned more than 10000 results'}}
            }
        })
        let blocks = await collect(build())
        expectTransfers(blocks)
        let spans = server.callsOf('eth_getLogs').map(span)
        expect(spans.filter((s) => s == 10)).toHaveLength(4)
        expect(spans.filter((s) => s == 5)).toHaveLength(8)
        expect(Math.max(...spans.filter((s) => s < 5))).toBeLessThanOrEqual(3)
    })

    it('splits by maxLogsRange without asking the provider first', async () => {
        await collect(build({maxLogsRange: 4}))
        let spans = server.callsOf('eth_getLogs').map(span)
        expect(Math.max(...spans)).toBe(4)
        expect(spans.reduce((a, b) => a + b, 0)).toBe(40)
    })

    it('re-fetches by block hash when a log carries a foreign block hash', async () => {
        let foreign = hashOf('x', 105)
        let once = true
        server.hooks.push((call, next) => {
            if (call.method == 'eth_getLogs' && call.params[0].fromBlock && once) {
                once = false
                let logs = next() as any[]
                return {result: logs.map((l) => (l.blockNumber == '0x69' ? {...l, blockHash: foreign} : l))}
            }
        })
        expectTransfers(await collect(build()))
        let byHash = server.callsOf('eth_getLogs').filter((c) => c.params[0].blockHash)
        expect(byHash.map((c) => c.params[0].blockHash)).toEqual([hashOf('a', 105)])
        expect(byHash[0].params[0].topics).toEqual([[TRANSFER]])
    })

    it('re-fetches by block hash when a lagging node returns no logs for a block', async () => {
        let once = true
        server.hooks.push((call, next) => {
            if (call.method == 'eth_getLogs' && call.params[0].fromBlock && span(call) == 10 && once) {
                once = false
                let logs = next() as any[]
                return {result: logs.filter((l) => parseInt(l.blockNumber, 16) < 107)}
            }
        })
        expectTransfers(await collect(build()))
        let byHash = server.callsOf('eth_getLogs').filter((c) => c.params[0].blockHash)
        expect(byHash.map((c) => c.params[0].blockHash)).toEqual([107, 108, 109].map((n) => hashOf('a', n)))
    })

    it('re-requests a block whose header came from a stale node', async () => {
        // A stale node serves header 108 of fork "x", which the node answering by hash never saw.
        let stale = makeBlock(108, 'x', hashOf('a', 107))
        let once = true
        server.hooks.push((call) => {
            if (call.method == 'eth_getBlockByNumber' && call.params[0] == '0x6c' && once) {
                once = false
                return {result: headerJson(stale, false)}
            }
        })
        expectTransfers(await collect(build()))
        let byHash = server.callsOf('eth_getLogs').filter((c) => c.params[0].blockHash)
        expect(byHash.map((c) => c.params[0].blockHash)).toEqual([stale.hash])
        // Header 108 read three times: stale, the consistency re-check, the re-request.
        expect(server.callsOf('eth_getBlockByNumber').filter((c) => c.params[0] == '0x6c')).toHaveLength(3)
    })

    it('retries 429 responses instead of failing', async () => {
        let failures = {getLogs: 2, headers: 1}
        server.hooks.push((call) => {
            if (call.method == 'eth_getLogs' && failures.getLogs > 0) {
                failures.getLogs -= 1
                return {httpStatus: 429}
            }
            if (call.method == 'eth_getBlockByNumber' && call.params[0] == '0x64' && failures.headers > 0) {
                failures.headers -= 1
                return {httpStatus: 429}
            }
        })
        let source = build()
        expectTransfers(await collect(source))
        expect(source.meter.counts.errors['eth_getLogs']).toBe(2)
        expect(server.callsOf('eth_getLogs')).toHaveLength(6)
    })

    it('follows the head through getStream', async () => {
        server.chain.finalized = 120
        let source = build()
        let blocks: Out[] = []
        let finalized = 0
        for await (let batch of source.getStream({from: 100, to: 139})) {
            blocks.push(...batch.blocks)
            finalized = Math.max(finalized, batch.finalizedHead?.number ?? 0)
        }
        expectTransfers(blocks)
        expect(finalized).toBeGreaterThanOrEqual(120)
    })
})
