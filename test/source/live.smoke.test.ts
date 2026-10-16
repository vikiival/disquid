import {describe, expect, it} from 'vitest'

import {DiscoveryRpcSourceBuilder} from '../../src/source'
import {TRANSFER} from './fake-rpc'

// Cost real RPC credits: the range check (~115 calls) runs only with LIVE_RPC_SMOKE=1, the
// head sample (~15 calls/min) only with LIVE_RPC_HEAD_SECONDS=<n>; both need RPC_URL.
const FROM = 26_104_555
const TO = FROM + 99

async function rpc(method: string, params: unknown[]): Promise<any> {
    let res = await fetch(process.env.RPC_URL!, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    })
    let body: any = await res.json()
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
}

describe.skipIf(!process.env.LIVE_RPC_SMOKE || !process.env.RPC_URL)('live RPC smoke', () => {
    it('matches a direct eth_getLogs count', async () => {
        let finalized = parseInt((await rpc('eth_getBlockByNumber', ['finalized', false])).number, 16)
        expect(finalized).toBeGreaterThan(TO)

        let source = new DiscoveryRpcSourceBuilder()
            .setRpc({
                url: process.env.RPC_URL!,
                network: 'ethereum-mainnet',
                strideSize: 20,
                strideConcurrency: 2,
                metricsInterval: 0,
            })
            .setFields({
                block: {timestamp: true},
                log: {address: true, topics: true, data: true, transactionHash: true},
            })
            .addLog({where: {topic0: [TRANSFER]}, range: {from: FROM, to: TO}})
            .includeAllBlocks({from: FROM, to: TO})
            .build()

        let started = Date.now()
        let blocks = 0
        let logs = 0
        for await (let batch of source.getFinalizedStream({from: FROM, to: TO})) {
            blocks += batch.blocks.length
            for (let b of batch.blocks) logs += b.logs.length
        }
        let elapsed = Date.now() - started

        let direct = 0
        for (let beg = FROM; beg <= TO; beg += 25) {
            let res = await rpc('eth_getLogs', [
                {fromBlock: '0x' + beg.toString(16), toBlock: '0x' + Math.min(TO, beg + 24).toString(16), topics: [TRANSFER]},
            ])
            direct += res.length
        }

        console.log(JSON.stringify({blocks, logs, direct, elapsedMs: elapsed, ...source.meter.counts}))
        expect(blocks).toBe(TO - FROM + 1)
        expect(logs).toBe(direct)
    }, 120_000)
})

const HEAD_SECONDS = Number(process.env.LIVE_RPC_HEAD_SECONDS ?? 0)

describe.skipIf(!(HEAD_SECONDS > 0) || !process.env.RPC_URL)('live RPC head sample', () => {
    it('follows the head', async () => {
        let head = parseInt((await rpc('eth_blockNumber', [])).toString(), 16)
        let source = new DiscoveryRpcSourceBuilder()
            .setRpc({url: process.env.RPC_URL!, network: 'ethereum-mainnet', strideSize: 20, metricsInterval: 0})
            .setFields({block: {timestamp: true}, log: {topics: true}})
            .addLog({where: {topic0: [TRANSFER]}, range: {from: head - 2}})
            .includeAllBlocks({from: head - 2})
            .build()

        let started = Date.now()
        let blocks: {number: number; lagMs: number; logs: number}[] = []
        let stream = source.getStream({from: head - 2})
        for await (let batch of stream) {
            for (let b of batch.blocks) {
                blocks.push({number: b.header.number, lagMs: Date.now() - b.header.timestamp, logs: b.logs.length})
            }
            if (Date.now() - started > HEAD_SECONDS * 1000) break
        }
        let minutes = (Date.now() - started) / 60_000
        let perMinute = Object.fromEntries(
            Object.entries(source.meter.counts.calls).map(([m, n]) => [m, Math.round((n / minutes) * 10) / 10]),
        )
        console.log(JSON.stringify({minutes, blocks, ...source.meter.counts, perMinute}))
        expect(blocks.length).toBeGreaterThan(0)
    }, (HEAD_SECONDS + 60) * 1000)
})
