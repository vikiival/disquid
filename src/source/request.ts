import type {FieldSelection} from '@subsquid/evm-stream'
import {type FlatDataRequest, unionRequiredData} from '@subsquid/squid-sdk/evm/rpc'

/** Node-side `eth_getLogs` filter. An omitted field means "any". */
export interface LogsFilter {
    topic0?: string[]
    address?: string[]
}

// Providers reject huge address lists; topic0 alone keeps the result small enough.
const MAX_PUSHDOWN_ADDRESSES = 1000

/**
 * True when some request needs transaction objects (or receipts, traces, state diffs, which
 * are correlated to them). Otherwise a block is fully described by its header plus logs.
 */
export function needsTransactions(requests: FlatDataRequest[], fields: FieldSelection): boolean {
    let coarse = unionRequiredData(requests, fields)
    if (coarse.receipts || coarse.traces || coarse.stateDiffs) return true
    if (Object.values(fields.transaction ?? {}).some(Boolean)) return true
    for (let req of requests) {
        if (req.transactions?.length) return true
        for (let items of [req.logs, req.traces, req.stateDiffs]) {
            if (items?.some((it) => it.transaction)) return true
        }
    }
    return false
}

/**
 * The union of what the client-side filter can match, so the node may only return a superset.
 * Only topic0 and address are pushed down; ranges are ignored (a union over all ranges is a
 * superset for every block). Anything that needs all logs of a transaction disables the filter.
 */
export function deriveLogsFilter(requests: FlatDataRequest[]): LogsFilter {
    let items = requests.flatMap((r) => r.logs ?? [])
    let needsWholeTx = requests.some(
        (r) =>
            r.transactions?.some((tx) => tx.logs) ||
            r.traces?.some((tr) => tr.transactionLogs) ||
            r.logs?.some((log) => log.transactionLogs),
    )
    if (needsWholeTx || items.length == 0) return {}

    let filter: LogsFilter = {}
    if (items.every((it) => it.topic0?.length)) {
        filter.topic0 = unique(items.flatMap((it) => it.topic0!))
    }
    if (items.every((it) => it.address?.length)) {
        let address = unique(items.flatMap((it) => it.address!))
        if (address.length <= MAX_PUSHDOWN_ADDRESSES) filter.address = address
    }
    return filter
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((v) => v.toLowerCase()))].sort()
}
