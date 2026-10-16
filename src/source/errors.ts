// Duck-typed on purpose: rpc-client and http-client may be loaded as more than one copy.

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message.toLowerCase() : ''
}

function httpStatus(err: unknown): number | undefined {
    let status = (err as any)?.response?.status
    return typeof status == 'number' ? status : undefined
}

function isRpcError(err: unknown): boolean {
    return err instanceof Error && err.name == 'RpcError'
}

export function isRateLimit(err: unknown): boolean {
    if (httpStatus(err) == 429) return true
    return isRpcError(err) && /rate.?limit|too many requests|request rate|credits|quota/.test(messageOf(err))
}

/**
 * The provider refuses the range or the result size; a smaller range will succeed. Checked
 * before rate limits are retried: Infura reports both under code -32005, which EvmRpcClient
 * would otherwise retry forever.
 */
export function isTooLarge(err: unknown): boolean {
    if (httpStatus(err) == 413) return true
    if (!isRpcError(err) || isRateLimit(err)) return false
    return /query returned more than|more than \d+ (results|logs)|block range|range (is )?too (large|wide|big)|ranges? over \d+ blocks?|max(imum)? (block )?range|is limited to|too large|too big|response size|size exceeded|limit exceeded|exceeds? (the )?(max|limit)/.test(
        messageOf(err),
    )
}

export function isTimeout(err: unknown): boolean {
    if (err instanceof Error && err.name == 'HttpTimeoutError') return true
    let status = httpStatus(err)
    if (status == 408 || status == 504) return true
    return isRpcError(err) && /time(d)? ?out/.test(messageOf(err))
}

/** `eth_getLogs({blockHash})` for a hash the serving node does not have. */
export function isUnknownBlock(err: unknown): boolean {
    return isRpcError(err) && /unknown block|block not found|not found|header not found|cannot find/.test(messageOf(err))
}

/** A provider-suggested sub-range such as "... try with this block range [0x10, 0x1f]". */
export function suggestedRange(err: unknown): {from: number; to: number} | undefined {
    let m = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/.exec(messageOf(err))
    if (m == null) return undefined
    return {from: parseInt(m[1], 16), to: parseInt(m[2], 16)}
}
