/** A balance read at block `block` (hash `hash`), remembered at wall-clock time `storedAt`. */
export interface CachedBalance {
    balance: bigint
    block: number
    hash: string
    storedAt: number
}

/** Insertion-ordered Map used as an LRU: a hit moves the key to the end, eviction takes the head. */
export class LruMap<K, V> {
    private map = new Map<K, V>()

    constructor(readonly capacity: number) {
        if (!(capacity >= 1)) throw new Error(`LRU capacity must be >= 1, got ${capacity}`)
    }

    get size(): number {
        return this.map.size
    }

    get(key: K): V | undefined {
        let value = this.map.get(key)
        if (value !== undefined) {
            this.map.delete(key)
            this.map.set(key, value)
        }
        return value
    }

    set(key: K, value: V): void {
        this.map.delete(key)
        this.map.set(key, value)
        if (this.map.size > this.capacity) {
            this.map.delete(this.map.keys().next().value as K)
        }
    }

    delete(key: K): void {
        this.map.delete(key)
    }
}

export interface BalanceCacheOptions {
    maxEntries: number
    maxAgeMs: number
    /** Tokens whose balances change without a Transfer event (rebasing, wrapped native, ...). */
    alwaysRefresh: ReadonlySet<string>
    now?: () => number
}

/**
 * Change-driven balance cache keyed by (account, token).
 *
 * An entry read at block R is still the balance at the served block S when no Transfer touched
 * the pair after R (`lastSeenBlock <= R`), R is still canonical (checked by the caller against the
 * `block` table in the request's snapshot, see {@link confirm}) and the token cannot change balances
 * silently. `maxAgeMs` bounds the damage of non-Transfer balance changes we do not know about.
 */
export class BalanceCache {
    private lru: LruMap<string, CachedBalance>
    private now: () => number

    constructor(private options: BalanceCacheOptions) {
        this.lru = new LruMap(options.maxEntries)
        this.now = options.now ?? Date.now
    }

    get size(): number {
        return this.lru.size
    }

    /**
     * Entries that may be served at block `servedBlock`, pending the canonical-hash check.
     * Stale entries (too old) are dropped on the way.
     */
    candidates(
        account: string,
        rows: readonly {token: string; lastSeenBlock: number}[],
        servedBlock: number,
    ): Map<string, CachedBalance> {
        let out = new Map<string, CachedBalance>()
        let now = this.now()
        for (let row of rows) {
            if (this.options.alwaysRefresh.has(row.token)) continue
            let key = cacheKey(account, row.token)
            let entry = this.lru.get(key)
            if (entry == null) continue
            if (now - entry.storedAt >= this.options.maxAgeMs) {
                this.lru.delete(key)
                continue
            }
            // R > S happens when a concurrent request stored a newer read; it is not stale,
            // just not servable from this (older) snapshot.
            if (entry.block > servedBlock) continue
            if (row.lastSeenBlock > entry.block) continue
            out.set(row.token, entry)
        }
        return out
    }

    /**
     * Keeps the candidates whose block is still canonical. `canonical` maps block number to hash
     * as seen in the same snapshot that produced `servedBlock`, which contains every block <= S
     * within retention; a missing or different hash means R was reorged out or pruned.
     */
    confirm(
        account: string,
        candidates: ReadonlyMap<string, CachedBalance>,
        canonical: ReadonlyMap<number, string>,
    ): Map<string, CachedBalance> {
        let out = new Map<string, CachedBalance>()
        for (let [token, entry] of candidates) {
            if (canonical.get(entry.block) === entry.hash) {
                out.set(token, entry)
            } else {
                this.lru.delete(cacheKey(account, token))
            }
        }
        return out
    }

    store(account: string, token: string, balance: bigint, block: number, hash: string): void {
        let key = cacheKey(account, token)
        let prev = this.lru.get(key)
        // Never replace a read from a later block with one from an earlier block.
        if (prev != null && prev.block > block) return
        this.lru.set(key, {balance, block, hash, storedAt: this.now()})
    }
}

function cacheKey(account: string, token: string): string {
    return account + token
}
