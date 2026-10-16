import {TokenStandard} from '../model'
import type {BalanceErrorCode, BalanceService, CachedBalance, ServedBlock} from './balances/service'

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500

/** The slice of TypeORM's EntityManager / DataSource this module needs (keeps tests honest and small). */
export interface SqlRunner {
    query(sql: string, parameters?: unknown[]): Promise<any>
}

export interface SnapshotSource {
    transaction<T>(isolationLevel: 'REPEATABLE READ', run: (em: SqlRunner) => Promise<T>): Promise<T>
}

export interface TokenDiscoveryArgs {
    account: string
    standard?: TokenStandard | null
    includeBalances?: boolean | null
    first?: number | null
    after?: string | null
}

export interface DiscoveredTokenData {
    token: string
    name: string | null
    symbol: string | null
    decimals: number | null
    firstSeenBlock: number
    lastSeenBlock: number
    sentCount: number
    receivedCount: number
    balance: bigint | null
    balanceFormatted: string | null
    balanceBlock: number | null
    balanceError: BalanceErrorCode | null
}

export interface TokenDiscoveryData {
    account: string
    standard: TokenStandard
    blockHeight: number
    blockHash: string
    blockTimestamp: Date
    tokens: DiscoveredTokenData[]
    nextCursor: string | null
    balancesComplete: boolean | null
}

/** A client-facing error; graphql-js copies `extensions` into the response. */
export class TokenDiscoveryError extends Error {
    readonly extensions: {code: string}

    constructor(code: 'BAD_USER_INPUT' | 'INDEX_NOT_READY', message: string) {
        super(message)
        this.name = 'TokenDiscoveryError'
        this.extensions = {code}
    }
}

interface NormalisedArgs {
    account: string
    standard: TokenStandard
    includeBalances: boolean
    first: number
    after: string | null
}

const ADDRESS = /^0x[0-9a-f]{40}$/i

/** `balance / 10^decimals` as a plain decimal string without trailing zeros ("1234.5"), in bigint math. */
export function formatUnits(balance: bigint, decimals: number): string {
    let digits = balance.toString().padStart(decimals + 1, '0')
    let whole = digits.slice(0, digits.length - decimals)
    let fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
    return fraction === '' ? whole : `${whole}.${fraction}`
}

export function normaliseArgs(args: TokenDiscoveryArgs): NormalisedArgs {
    if (!ADDRESS.test(args.account)) {
        throw new TokenDiscoveryError('BAD_USER_INPUT', `account must be a 0x-prefixed 20-byte hex address, got "${args.account}"`)
    }
    let first = args.first ?? DEFAULT_PAGE_SIZE
    if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
        throw new TokenDiscoveryError('BAD_USER_INPUT', `first must be between 1 and ${MAX_PAGE_SIZE}, got ${first}`)
    }
    let after = args.after ?? null
    if (after != null && !ADDRESS.test(after)) {
        throw new TokenDiscoveryError('BAD_USER_INPUT', `after must be a nextCursor from a previous page (a token address), got "${after}"`)
    }
    let standard = args.standard ?? TokenStandard.ERC20
    let includeBalances = args.includeBalances ?? false
    if (includeBalances && standard === TokenStandard.ERC1155) {
        // ERC-1155 balances are per token id (balanceOfBatch), not per contract.
        throw new TokenDiscoveryError('BAD_USER_INPUT', 'includeBalances is not supported for ERC1155')
    }
    return {
        account: args.account.toLowerCase(),
        standard,
        includeBalances,
        first,
        after: after?.toLowerCase() ?? null,
    }
}

interface HeadRow {
    number: number
    hash: string
    timestamp: Date
}

interface AccountTokenRow {
    token: string
    name: string | null
    symbol: string | null
    decimals: number | null
    firstSeenBlock: number
    lastSeenBlock: number
    sentCount: number
    receivedCount: number
}

const HEAD_SQL = `
    SELECT number, hash, timestamp
    FROM block
    ORDER BY number DESC
    LIMIT 1`

// Served by the unique index (account, standard, token_id); keyset pagination stays stable while
// new tokens are discovered between pages.
const ROWS_SQL = `
    SELECT
        at.token_id AS "token",
        t.name AS "name",
        t.symbol AS "symbol",
        t.decimals AS "decimals",
        at.first_seen_block AS "firstSeenBlock",
        at.last_seen_block AS "lastSeenBlock",
        at.sent_count AS "sentCount",
        at.received_count AS "receivedCount"
    FROM account_token at
    LEFT JOIN token t ON t.id = at.token_id
    WHERE at.account = $1
        AND at.standard = $2
        AND at.token_id IS NOT NULL
        AND ($3::varchar IS NULL OR at.token_id > $3::varchar)
    ORDER BY at.token_id
    LIMIT $4`

const BLOCK_HASHES_SQL = `
    SELECT number, hash
    FROM block
    WHERE number = ANY($1::int4[])`

/**
 * One page of the account's tokens and the block it is valid for.
 *
 * The head block, the rows and the cache's canonical-hash check all come from one REPEATABLE READ
 * snapshot, so the page is exactly the index state at `blockHeight`. Balance RPC calls happen
 * after the transaction has been released.
 */
export async function discoverTokens(
    db: SnapshotSource,
    rawArgs: TokenDiscoveryArgs,
    balances?: BalanceService,
): Promise<TokenDiscoveryData> {
    let args = normaliseArgs(rawArgs)
    let service = args.includeBalances ? balances : undefined
    if (args.includeBalances && service == null) {
        throw new Error('includeBalances requires a balance service')
    }

    let snapshot = await db.transaction('REPEATABLE READ', async em => {
        let heads: HeadRow[] = await em.query(HEAD_SQL)
        if (heads.length === 0) return undefined
        let head = heads[0]
        let rows: AccountTokenRow[] = await em.query(ROWS_SQL, [args.account, args.standard, args.after, args.first + 1])
        let page = rows.slice(0, args.first)
        let cached = service
            ? await service.fromCache(args.account, page, head, async numbers => {
                let found: {number: number; hash: string}[] = await em.query(BLOCK_HASHES_SQL, [numbers])
                return new Map(found.map(b => [b.number, b.hash]))
            })
            : new Map<string, CachedBalance>()
        return {head, page, hasMore: rows.length > args.first, cached}
    })
    if (snapshot == null) {
        throw new TokenDiscoveryError('INDEX_NOT_READY', 'The index has not processed any block yet; retry once it has synced')
    }

    let {head, page, hasMore, cached} = snapshot
    let served: ServedBlock = {number: head.number, hash: head.hash}
    let fetched = service
        ? await service.fetch(args.account, page.filter(r => !cached.has(r.token)).map(r => r.token), served)
        : undefined

    let tokens = page.map((row): DiscoveredTokenData => {
        let hit = cached.get(row.token)
        let outcome = fetched?.get(row.token)
        let balance = hit?.balance ?? outcome?.balance ?? null
        return {
            ...row,
            balance,
            balanceFormatted: balance != null && row.decimals != null ? formatUnits(balance, row.decimals) : null,
            balanceBlock: hit ? hit.block : outcome?.balance !== undefined ? served.number : null,
            balanceError: outcome?.error ?? null,
        }
    })

    return {
        account: args.account,
        standard: args.standard,
        blockHeight: head.number,
        blockHash: head.hash,
        blockTimestamp: head.timestamp,
        tokens,
        nextCursor: hasMore ? page[page.length - 1].token : null,
        balancesComplete: args.includeBalances ? tokens.every(t => t.balance != null) : null,
    }
}
