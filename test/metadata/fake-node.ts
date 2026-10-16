import * as p from '@subsquid/evm-codec'
import {func} from '@subsquid/evm-abi'
import {RpcError} from '@subsquid/rpc-client'
import * as erc20 from '../../src/abi/erc20'
import type {EthCallClient} from '../../src/metadata'
import {aggregate3} from '../../src/rpc/multicall3'
import {encodeAggregate3Result, uint256} from '../api/fakes'

const stringEncoder = func('0x00000000', {value: p.string})

/** ABI return data of a `string` function. */
export const abiString = (value: string) => '0x' + stringEncoder.encode({value}).slice(10)

/** Return data of a `bytes32` function (MKR / SAI style). */
export const bytes32 = (value: string) => '0x' + Buffer.from(value).toString('hex').padEnd(64, '0')

export type Answer = string | 'revert'

export interface FakeToken {
    name?: Answer
    symbol?: Answer
    decimals?: Answer
}

export const execError = () => new RpcError({code: -32000, message: 'execution reverted: out of gas'})
export const downError = () => new RpcError({code: -32005, message: 'rate limit exceeded'})

/** Multicall3 node double answering name/symbol/decimals per token; unknown tokens behave like an EOA. */
export class FakeMetadataNode implements EthCallClient {
    calls: {to: string; tokens: string[]; block: string}[] = []
    fail?: Error
    /** Whole-call failure for any call containing one of these tokens. */
    poison = new Set<string>()

    constructor(public tokens: Record<string, FakeToken> = {}) {}

    async call(_method: 'eth_call', [{to, data}, block]: [{to: string; data: string}, 'latest']): Promise<string> {
        let {calls} = aggregate3.decode(data)
        let targets = calls.map(c => c.target)
        this.calls.push({to, tokens: [...new Set(targets)], block})
        if (this.fail) throw this.fail
        if (targets.some(t => this.poison.has(t))) throw execError()
        return encodeAggregate3Result(calls.map(c => {
            let token = this.tokens[c.target]
            let field = (['name', 'symbol', 'decimals'] as const).find(f => erc20.functions[f].selector === c.callData.slice(0, 10))!
            let answer = token?.[field]
            if (answer == null) return {success: true, returnData: '0x'}
            if (answer === 'revert') return {success: false, returnData: '0x'}
            return {success: true, returnData: answer}
        }))
    }
}

export const decimalsWord = (n: bigint) => uint256(n)
