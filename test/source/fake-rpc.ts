import {createHash} from 'node:crypto'
import {createServer, Server} from 'node:http'
import type {AddressInfo} from 'node:net'

import {logsBloom} from '@subsquid/evm-rpc/lib/verification'

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
export const TOKEN_A = '0x' + 'aa'.repeat(20)
export const TOKEN_B = '0x' + 'bb'.repeat(20)

const ZERO32 = '0x' + '00'.repeat(32)

export interface RpcLog {
    blockHash: string
    blockNumber: string
    transactionHash: string
    transactionIndex: string
    logIndex: string
    address: string
    topics: string[]
    data: string
    removed?: boolean
}

export interface FakeBlock {
    number: number
    hash: string
    parentHash: string
    timestamp: number
    logs: RpcLog[]
    txHashes: string[]
}

export interface RpcCall {
    method: string
    params: any[]
}

/** Return a value to answer the call yourself: `{error}`, `{httpStatus}` or `{result}`. */
export type Hook = (call: RpcCall, next: () => unknown) => {error?: {code: number; message: string}; httpStatus?: number; result?: unknown} | undefined

const hex = (n: number) => '0x' + n.toString(16)
const word = (s: string) => '0x' + createHash('sha256').update(s).digest('hex')
const topicOf = (addr: string) => '0x' + addr.slice(2).padStart(64, '0')

export function hashOf(tag: string, n: number): string {
    return word(`block:${tag}:${n}`)
}

/** Two transactions; tx 0 emits Transfer(A), Approval(A); tx 1 emits Transfer(B). */
export function makeBlock(n: number, tag: string, parentHash: string, timestamp = 1_700_000_000 + n * 12): FakeBlock {
    let hash = hashOf(tag, n)
    let txHashes = [word(`tx:${tag}:${n}:0`), word(`tx:${tag}:${n}:1`)]
    let from = topicOf('0x' + n.toString(16).padStart(40, '1'))
    let to = topicOf('0x' + n.toString(16).padStart(40, '2'))
    let spec: [number, string, string[]][] = [
        [0, TOKEN_A, [TRANSFER, from, to]],
        [0, TOKEN_A, [APPROVAL, from, to]],
        [1, TOKEN_B, [TRANSFER, to, from]],
    ]
    let logs = spec.map(([tx, address, topics], i) => ({
        blockHash: hash,
        blockNumber: hex(n),
        transactionHash: txHashes[tx],
        transactionIndex: hex(tx),
        logIndex: hex(i),
        address,
        topics,
        data: hex(1000 + n * 10 + i).padEnd(66, '0'),
        removed: false,
    }))
    return {number: n, hash, parentHash, timestamp, logs, txHashes}
}

export class FakeChain {
    byHash = new Map<string, FakeBlock>()
    canonical = new Map<number, string>()
    finalized = 0

    /** Append blocks `from..to` on fork `tag`, replacing the canonical chain from `from` up. */
    extend(from: number, to: number, tag: string, timestamp?: (n: number) => number): this {
        for (let n of [...this.canonical.keys()]) if (n >= from) this.canonical.delete(n)
        for (let n = from; n <= to; n++) {
            let parent = this.canonical.get(n - 1) ?? hashOf('genesis', n - 1)
            let block = makeBlock(n, tag, parent, timestamp?.(n))
            this.byHash.set(block.hash, block)
            this.canonical.set(n, block.hash)
        }
        return this
    }

    get head(): number {
        return Math.max(...this.canonical.keys())
    }

    block(n: number): FakeBlock | undefined {
        let hash = this.canonical.get(n)
        return hash == null ? undefined : this.byHash.get(hash)
    }
}

export function headerJson(b: FakeBlock, full: boolean) {
    return {
        number: hex(b.number),
        hash: b.hash,
        parentHash: b.parentHash,
        extraData: '0x',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        sha3Uncles: ZERO32,
        logsBloom: logsBloom(b.logs as any),
        transactionsRoot: ZERO32,
        receiptsRoot: ZERO32,
        stateRoot: ZERO32,
        miner: '0x' + '00'.repeat(20),
        size: '0x100',
        timestamp: hex(b.timestamp),
        // Full transaction objects are never needed by these tests.
        transactions: full ? [] : b.txHashes,
        uncles: [],
    }
}

function matches(log: RpcLog, filter: {address?: string | string[]; topics?: (string | string[] | null)[]}): boolean {
    if (filter.address != null) {
        let addrs = ([] as string[]).concat(filter.address).map((a) => a.toLowerCase())
        if (!addrs.includes(log.address)) return false
    }
    let t0 = filter.topics?.[0]
    if (t0 != null) {
        let topics = ([] as string[]).concat(t0)
        if (!topics.includes(log.topics[0])) return false
    }
    return true
}

export class FakeRpcServer {
    calls: RpcCall[] = []
    httpRequests = 0
    hooks: Hook[] = []
    private server: Server
    url = ''

    constructor(public chain: FakeChain) {
        this.server = createServer((req, res) => {
            let body = ''
            req.on('data', (chunk) => (body += chunk))
            req.on('end', () => {
                this.httpRequests += 1
                let parsed = JSON.parse(body)
                let items: any[] = Array.isArray(parsed) ? parsed : [parsed]
                let answers = items.map((item) => this.answer({method: item.method, params: item.params ?? []}))
                let httpStatus = answers.find((a) => a.httpStatus)?.httpStatus
                if (httpStatus) {
                    res.writeHead(httpStatus, {'content-type': 'text/plain'})
                    res.end('injected http error')
                    return
                }
                let responses = items.map((item, i) => {
                    let a = answers[i]
                    return a.error ? {jsonrpc: '2.0', id: item.id, error: a.error} : {jsonrpc: '2.0', id: item.id, result: a.result}
                })
                res.writeHead(200, {'content-type': 'application/json'})
                res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]))
            })
        })
    }

    async start(): Promise<this> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
        return this
    }

    async stop(): Promise<void> {
        this.server.closeAllConnections()
        await new Promise((resolve) => this.server.close(resolve))
    }

    callsOf(method: string): RpcCall[] {
        return this.calls.filter((c) => c.method == method)
    }

    private answer(call: RpcCall): {error?: {code: number; message: string}; httpStatus?: number; result?: unknown} {
        this.calls.push(call)
        let compute = () => this.handle(call)
        for (let hook of this.hooks) {
            let out = hook(call, compute)
            if (out) return out
        }
        try {
            return {result: compute()}
        } catch (err: any) {
            return {error: {code: -32000, message: err.message}}
        }
    }

    handle(call: RpcCall): unknown {
        let chain = this.chain
        let [p0, p1] = call.params
        switch (call.method) {
            case 'eth_chainId':
                return '0x1'
            case 'eth_blockNumber':
                return hex(chain.head)
            case 'eth_getBlockByNumber': {
                let n = p0 == 'latest' ? chain.head : p0 == 'finalized' ? chain.finalized : parseInt(p0, 16)
                let b = chain.block(n)
                return b ? headerJson(b, p1) : null
            }
            case 'eth_getBlockByHash': {
                let b = chain.byHash.get(p0)
                return b ? headerJson(b, p1) : null
            }
            case 'eth_getLogs': {
                if (p0.blockHash) {
                    let b = chain.byHash.get(p0.blockHash)
                    if (b == null) throw new Error('unknown block')
                    return b.logs.filter((l) => matches(l, p0))
                }
                let logs: RpcLog[] = []
                for (let n = parseInt(p0.fromBlock, 16); n <= parseInt(p0.toBlock, 16); n++) {
                    let b = chain.block(n)
                    if (b) logs.push(...b.logs.filter((l) => matches(l, p0)))
                }
                return logs
            }
            default:
                throw new Error(`method ${call.method} not supported`)
        }
    }
}

export function span(call: RpcCall): number {
    return parseInt(call.params[0].toBlock, 16) - parseInt(call.params[0].fromBlock, 16) + 1
}
