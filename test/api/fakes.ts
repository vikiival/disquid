import * as p from '@subsquid/evm-codec'
import {func} from '@subsquid/evm-abi'
import * as erc20 from '../../src/abi/erc20'
import type {EthCallTransport} from '../../src/server-extension/balances/batcher'
import {aggregate3} from '../../src/rpc/multicall3'

// Encoding the aggregate3 *result* as if it were call arguments gives the same ABI bytes
// after the 4-byte selector.
const resultEncoder = func('0x00000000', {results: p.array(p.struct({success: p.bool, returnData: p.bytes}))})

export function encodeAggregate3Result(results: {success: boolean; returnData: string}[]): string {
    return '0x' + resultEncoder.encode({results}).slice(10)
}

export function uint256(value: bigint): string {
    return '0x' + value.toString(16).padStart(64, '0')
}

export interface ReceivedCall {
    to: string
    blockHash: string
    pairs: {token: string; account: string}[]
}

type Answer = bigint | 'revert' | 'empty'

/**
 * Multicall3 node double: decodes the aggregate3 calldata and answers each balanceOf with
 * `answer(token, account, blockHash)`. `gate` lets a test hold calls in flight.
 */
export class FakeMulticallNode implements EthCallTransport {
    calls: ReceivedCall[] = []
    inFlight = 0
    maxInFlight = 0
    gate?: Promise<void>
    fail?: Error

    constructor(private answer: (token: string, account: string, blockHash: string) => Answer = () => 1n) {}

    async ethCall(to: string, data: string, blockHash: string): Promise<string> {
        let {calls} = aggregate3.decode(data)
        let pairs = calls.map(c => ({token: c.target, account: erc20.functions.balanceOf.decode(c.callData)._owner}))
        this.calls.push({to, blockHash, pairs})
        this.inFlight += 1
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        try {
            await this.gate
            if (this.fail) throw this.fail
            return encodeAggregate3Result(pairs.map(({token, account}) => {
                let a = this.answer(token, account, blockHash)
                if (a === 'revert') return {success: false, returnData: '0x'}
                if (a === 'empty') return {success: true, returnData: '0x'}
                return {success: true, returnData: uint256(a)}
            }))
        } finally {
            this.inFlight -= 1
        }
    }
}

export function deferred(): {promise: Promise<void>; resolve: () => void} {
    let resolve!: () => void
    let promise = new Promise<void>(r => {
        resolve = r
    })
    return {promise, resolve}
}

export function addr(n: number): string {
    return '0x' + n.toString(16).padStart(40, '0')
}

export function hash(n: number): string {
    return '0x' + n.toString(16).padStart(64, '0')
}
