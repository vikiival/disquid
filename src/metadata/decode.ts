import * as erc20 from '../abi/erc20'

export interface TokenMetadata {
    name: string | null
    symbol: string | null
    decimals: number | null
}

export const MAX_NAME = 128
export const MAX_SYMBOL = 64

// Postgres text rejects \0, and control characters have no place in a token label.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

function clean(value: string, max: number): string | null {
    let text = [...value.replace(CONTROL, '').trim()].slice(0, max).join('').trim()
    return text === '' ? null : text
}

/**
 * Decodes the return data of `name()` / `symbol()`: the standard `string`, or the `bytes32` that
 * MKR / SAI style tokens return. A valid `string` is at least two words, so one word is bytes32.
 */
export function decodeLabel(returnData: string, max: number): string | null {
    let bytes = (returnData.length - 2) / 2
    try {
        if (bytes === 32) {
            return clean(Buffer.from(returnData.slice(2), 'hex').toString('utf8'), max)
        }
        if (bytes < 64) return null
        return clean(erc20.functions.name.decodeResult(returnData), max)
    } catch {
        return null
    }
}

/** A uint256 word that fits in uint8; anything larger is a misbehaving token, not a decimals value. */
export function decodeDecimals(returnData: string): number | null {
    if (returnData.length < 66) return null
    let value = BigInt('0x' + returnData.slice(2, 66))
    return value <= 255n ? Number(value) : null
}
