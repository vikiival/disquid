import * as erc20 from '../../abi/erc20'
import {aggregate3} from '../../rpc/multicall3'

export interface BalanceCall {
    account: string
    token: string
}

/** `balanceOf(account)` on every token, each call allowed to fail on its own. */
export function encodeBalanceOfBatch(calls: readonly BalanceCall[]): string {
    return aggregate3.encode({
        calls: calls.map(c => ({
            target: c.token,
            allowFailure: true,
            callData: erc20.functions.balanceOf.encode({_owner: c.account}),
        })),
    })
}

/**
 * Decodes the aggregate3 result into one entry per call: the balance, or `undefined` when the
 * call reverted or returned something that is not a uint256 (EOA, non-token contract).
 */
export function decodeBalanceOfBatch(output: string, expected: number): (bigint | undefined)[] {
    let results = aggregate3.decodeResult(output)
    if (results.length !== expected) {
        throw new Error(`aggregate3 returned ${results.length} results for ${expected} calls`)
    }
    return results.map(r => {
        // A uint256 is exactly one word; anything shorter is not a balanceOf answer.
        if (!r.success || r.returnData.length < 66) return undefined
        try {
            return erc20.functions.balanceOf.decodeResult(r.returnData)
        } catch {
            return undefined
        }
    })
}
