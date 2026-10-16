import * as erc20 from '../abi/erc20'
import {aggregate3, MULTICALL3_ADDRESS} from '../rpc/multicall3'
import {decodeDecimals, decodeLabel, MAX_NAME, MAX_SYMBOL, type TokenMetadata} from './decode'

/** The one RpcClient method used here; tests pass a fake. */
export interface EthCallClient {
    call(method: 'eth_call', params: [{to: string; data: string}, 'latest']): Promise<string>
}

/** `'retry'`: the node could not answer (not the token's fault); the token stays PENDING. */
export type MetadataResult = TokenMetadata | 'retry'

export interface FetchOptions {
    /** Tokens per eth_call; each costs three sub-calls. */
    batchSize?: number
    multicallAddress?: string
}

const EMPTY: TokenMetadata = {name: null, symbol: null, decimals: null}

// What a node answers when the multicall itself fails in the EVM (a hostile token burning the
// gas), as opposed to a transport, rate-limit or server failure.
const EXECUTION_ERROR = /execution reverted|out of gas|gas (required )?exceeds|exceeds? (the )?(block )?gas|gas (limit|cap)|intrinsic gas/i

export function isExecutionError(err: unknown): boolean {
    return err instanceof Error && err.name === 'RpcError' && EXECUTION_ERROR.test(err.message)
}

function encodeBatch(tokens: string[]): string {
    let calls = tokens.flatMap(token => [
        erc20.functions.name.encode({}),
        erc20.functions.symbol.encode({}),
        erc20.functions.decimals.encode({}),
    ].map(callData => ({target: token, allowFailure: true, callData})))
    return aggregate3.encode({calls})
}

function decodeBatch(output: string, tokens: string[]): TokenMetadata[] {
    let results = aggregate3.decodeResult(output)
    if (results.length !== tokens.length * 3) {
        throw new Error(`aggregate3 returned ${results.length} results for ${tokens.length * 3} calls`)
    }
    // A failed sub-call (revert, EOA) leaves that field null.
    let data = (i: number) => (results[i].success ? results[i].returnData : '0x')
    return tokens.map((_, i) => ({
        name: decodeLabel(data(3 * i), MAX_NAME),
        symbol: decodeLabel(data(3 * i + 1), MAX_SYMBOL),
        decimals: decodeDecimals(data(3 * i + 2)),
    }))
}

/**
 * name/symbol/decimals of `tokens` at `latest` (metadata is effectively immutable, and `latest`
 * needs no archive node), one Multicall3 `eth_call` per chunk. Never rejects.
 *
 * An EVM-level failure of a whole call bisects the chunk down to the offending token, which then
 * gets all-null metadata. Any other failure marks the chunk `'retry'`, and the remaining chunks
 * too without calling: a node that is down must not stall indexing once per chunk.
 */
export async function fetchTokenMetadata(
    client: EthCallClient,
    tokens: string[],
    options: FetchOptions = {},
): Promise<Map<string, MetadataResult>> {
    let size = Math.max(1, options.batchSize ?? 50)
    let to = options.multicallAddress ?? MULTICALL3_ADDRESS
    let out = new Map<string, MetadataResult>()
    let nodeDown = false

    async function load(part: string[]): Promise<void> {
        if (nodeDown) {
            for (let token of part) out.set(token, 'retry')
            return
        }
        try {
            let output = await client.call('eth_call', [{to, data: encodeBatch(part)}, 'latest'])
            decodeBatch(output, part).forEach((meta, i) => out.set(part[i], meta))
        } catch (err) {
            if (!isExecutionError(err)) {
                nodeDown = true
                for (let token of part) out.set(token, 'retry')
            } else if (part.length === 1) {
                out.set(part[0], EMPTY)
            } else {
                let mid = part.length >> 1
                await load(part.slice(0, mid))
                await load(part.slice(mid))
            }
        }
    }

    let unique = [...new Set(tokens)]
    for (let i = 0; i < unique.length; i += size) await load(unique.slice(i, i + size))
    return out
}
