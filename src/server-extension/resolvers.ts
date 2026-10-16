import 'reflect-metadata'
import {Arg, Ctx, Field, Int, ObjectType, Query, Resolver, registerEnumType} from 'type-graphql'
import type {EntityManager} from 'typeorm'
import {TokenStandard} from '../model'
import {getBalanceService} from './balances/service'
import {DEFAULT_PAGE_SIZE, discoverTokens, MAX_PAGE_SIZE, type SnapshotSource} from './discovery'

// Same name and values as the enum openreader generates from schema.graphql: graphql-server merges
// the two schemas with @graphql-tools/merge, which folds same-named enums into one type.
registerEnumType(TokenStandard, {name: 'TokenStandard'})

export enum BalanceError {
    RPC_BUSY = 'RPC_BUSY',
    RPC_TIMEOUT = 'RPC_TIMEOUT',
    RPC_ERROR = 'RPC_ERROR',
    CALL_FAILED = 'CALL_FAILED',
}

registerEnumType(BalanceError, {
    name: 'BalanceError',
    description: 'Why a balance is missing. Discovery data is returned regardless; retry later for the balance.',
    valuesConfig: {
        RPC_BUSY: {description: 'Too many balance reads are queued; the read was not attempted.'},
        RPC_TIMEOUT: {description: 'The node did not answer within the request deadline.'},
        RPC_ERROR: {description: 'The node returned an error or could not be reached.'},
        CALL_FAILED: {description: 'balanceOf reverted or returned no uint256 (e.g. not a token contract any more).'},
    },
})

@ObjectType({description: 'A token the account has sent or received at least once since the index start block.'})
export class DiscoveredToken {
    @Field(() => String, {description: 'Token contract address (lowercase).'})
    token!: string

    @Field(() => String, {nullable: true, description: 'Token name, when known.'})
    name!: string | null

    @Field(() => String, {nullable: true, description: 'Token symbol, when known.'})
    symbol!: string | null

    @Field(() => Int, {nullable: true, description: 'Token decimals, when known. Balances are raw integers.'})
    decimals!: number | null

    @Field(() => Int, {description: 'First block with a transfer involving the account.'})
    firstSeenBlock!: number

    @Field(() => Int, {description: 'Last block with a transfer involving the account.'})
    lastSeenBlock!: number

    @Field(() => Int)
    sentCount!: number

    @Field(() => Int)
    receivedCount!: number

    @Field(() => BigInt, {
        nullable: true,
        description: 'Raw balance (no decimals applied). Null unless includeBalances is true and the read succeeded.',
    })
    balance!: bigint | null

    @Field(() => String, {
        nullable: true,
        description: 'Balance scaled by decimals as a plain decimal string without trailing zeros, e.g. "1234.5". ' +
            'Null when the balance or the decimals are unknown.',
    })
    balanceFormatted!: string | null

    @Field(() => Int, {
        nullable: true,
        description: 'Block the balance was read at. May be below blockHeight when served from cache: ' +
            'no transfer touched this account and token since then, so it is still the balance at blockHeight.',
    })
    balanceBlock!: number | null

    @Field(() => BalanceError, {nullable: true, description: 'Set when includeBalances is true but the balance could not be read.'})
    balanceError!: BalanceError | null
}

@ObjectType({description: 'One page of discovered tokens, consistent with a single indexed block.'})
export class TokenDiscoveryResult {
    @Field(() => String, {description: 'The queried account (lowercase).'})
    account!: string

    @Field(() => TokenStandard)
    standard!: TokenStandard

    @Field(() => Int, {description: 'The indexed block this page is exact for.'})
    blockHeight!: number

    @Field(() => String)
    blockHash!: string

    @Field(() => Date)
    blockTimestamp!: Date

    @Field(() => [DiscoveredToken], {description: 'Ordered by token address.'})
    tokens!: DiscoveredToken[]

    @Field(() => String, {nullable: true, description: 'Pass as `after` to get the next page; null on the last page.'})
    nextCursor!: string | null

    @Field(() => Boolean, {
        nullable: true,
        description: 'True when every token on this page has a balance; null when includeBalances is false.',
    })
    balancesComplete!: boolean | null
}

interface ServerContext {
    openreader?: {connection?: SnapshotSource}
}

@Resolver()
export class TokenDiscoveryResolver {
    constructor(private tx: () => Promise<EntityManager>) {}

    @Query(() => TokenDiscoveryResult, {
        description: 'ERC-20 (and later NFT) contracts an account has interacted with, with optional balances, ' +
            'paginated by token address and consistent with blockHeight.',
    })
    async tokenDiscovery(
        @Arg('account', () => String, {description: '0x-prefixed address, any case.'}) account: string,
        @Arg('standard', () => TokenStandard, {defaultValue: TokenStandard.ERC20}) standard: TokenStandard,
        @Arg('includeBalances', () => Boolean, {
            defaultValue: false,
            description: 'Read balances at blockHash (one coalesced Multicall3 call, cached while unchanged).',
        }) includeBalances: boolean,
        @Arg('first', () => Int, {defaultValue: DEFAULT_PAGE_SIZE, description: `Page size, 1..${MAX_PAGE_SIZE}.`}) first: number,
        @Arg('after', () => String, {nullable: true, description: 'nextCursor of the previous page.'}) after: string | null,
        @Ctx() ctx: ServerContext,
    ): Promise<TokenDiscoveryResult> {
        let result = await discoverTokens(
            await this.snapshotSource(ctx),
            {account, standard, includeBalances, first, after},
            includeBalances ? getBalanceService() : undefined,
        )
        return result as TokenDiscoveryResult
    }

    /**
     * The per-request transaction graphql-server hands to custom resolvers is READ COMMITTED and
     * opened lazily, so run our own REPEATABLE READ transaction on the server's DataSource instead.
     * Taking it from the context avoids opening (and pinning a pool connection for) the lazy one.
     */
    private async snapshotSource(ctx: ServerContext): Promise<SnapshotSource> {
        return ctx.openreader?.connection ?? (await this.tx()).connection
    }
}
