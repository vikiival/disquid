import {createLogger, Logger} from '@subsquid/logger'

export interface RpcCallCounts {
    /** Billable JSON-RPC calls by method: every batch item and every retry counts. */
    calls: Record<string, number>
    /** HTTP requests (a batch is one request). */
    httpRequests: number
    /** Failed sends (HTTP or transport errors, not JSON-RPC error responses) by method. */
    errors: Record<string, number>
}

/**
 * Counts what the provider bills: calls are counted at the transport, so retries and
 * batch items are included and nothing the client merely queues is.
 */
export class RpcCallMeter {
    private calls = new Map<string, number>()
    private errors = new Map<string, number>()
    private httpRequests = 0
    private lastReported?: Map<string, number>
    private timer?: NodeJS.Timeout

    recordRequest(methods: string[]): void {
        this.httpRequests += 1
        for (let m of methods) {
            this.calls.set(m, (this.calls.get(m) ?? 0) + 1)
        }
    }

    recordError(methods: string[]): void {
        for (let m of methods) {
            this.errors.set(m, (this.errors.get(m) ?? 0) + 1)
        }
    }

    get counts(): RpcCallCounts {
        return {
            calls: Object.fromEntries(this.calls),
            httpRequests: this.httpRequests,
            errors: Object.fromEntries(this.errors),
        }
    }

    get totalCalls(): number {
        let total = 0
        for (let n of this.calls.values()) total += n
        return total
    }

    /** Log a one-line summary every `intervalMs`; the timer never keeps the process alive. */
    startReporting(intervalMs: number, log: Logger = createLogger('sqd:rpc-cost')): void {
        if (this.timer != null || !(intervalMs > 0)) return
        this.timer = setInterval(() => this.report(log, intervalMs), intervalMs)
        this.timer.unref()
    }

    stopReporting(): void {
        clearInterval(this.timer)
        this.timer = undefined
    }

    private report(log: Logger, intervalMs: number): void {
        let prev = this.lastReported ?? new Map<string, number>()
        let parts: string[] = []
        let delta = 0
        for (let [method, n] of [...this.calls].sort((a, b) => b[1] - a[1])) {
            let d = n - (prev.get(method) ?? 0)
            if (d > 0) parts.push(`${method}=${d}`)
            delta += d
        }
        this.lastReported = new Map(this.calls)
        if (delta == 0) return
        let errors = [...this.errors].map(([m, n]) => `${m}=${n}`).join(' ')
        log.info(
            `${delta} calls in ${Math.round(intervalMs / 1000)}s: ${parts.join(' ')}; ` +
                `total ${this.totalCalls} calls / ${this.httpRequests} http` +
                (errors ? `; errors ${errors}` : ''),
        )
    }
}
