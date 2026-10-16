import type {DiscoveryStore} from '../../src/discovery'

// Minimal in-memory stand-in for the typeorm-store Store: understands In(...) / LessThan(...)
// find operators and records the calls that reach it.
export class FakeStore implements DiscoveryStore {
    tables = new Map<Function, Map<string, any>>()
    calls: {method: string; entity: string; count: number}[] = []

    table(cls: Function): Map<string, any> {
        let t = this.tables.get(cls)
        if (t == null) this.tables.set(cls, (t = new Map()))
        return t
    }

    private match(row: any, where: any): boolean {
        return Object.entries(where).every(([key, cond]: [string, any]) => {
            if (cond != null && typeof cond === 'object' && 'type' in cond) {
                if (cond.type === 'in') return cond.value.includes(row[key])
                if (cond.type === 'lessThan') return row[key] < cond.value
                throw new Error(`unsupported operator ${cond.type}`)
            }
            return row[key] === cond
        })
    }

    async findBy(cls: any, where: any) {
        const rows = [...this.table(cls).values()].filter(r => this.match(r, where))
        this.calls.push({method: 'findBy', entity: cls.name, count: rows.length})
        return rows.map(r => structuredClone(r))
    }

    async find(cls: any, options: any = {}) {
        let rows = [...this.table(cls).values()].filter(r => this.match(r, options.where ?? {}))
        const order = Object.entries(options.order ?? {})[0] as [string, string] | undefined
        if (order) rows.sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : 1) * (order[1] === 'DESC' ? -1 : 1))
        if (options.take != null) rows = rows.slice(0, options.take)
        this.calls.push({method: 'find', entity: cls.name, count: rows.length})
        return rows.map(r => structuredClone(r))
    }

    async insert(entities: any[]) {
        if (entities.length === 0) return
        const t = this.table(entities[0].constructor)
        for (const e of entities) {
            if (t.has(e.id)) throw new Error(`duplicate key ${e.id}`)
            t.set(e.id, e)
        }
        this.calls.push({method: 'insert', entity: entities[0].constructor.name, count: entities.length})
    }

    async upsert(entities: any[]) {
        if (entities.length === 0) return
        const t = this.table(entities[0].constructor)
        for (const e of entities) t.set(e.id, e)
        this.calls.push({method: 'upsert', entity: entities[0].constructor.name, count: entities.length})
    }

    async remove(cls: any, id: string | string[]) {
        const ids = Array.isArray(id) ? id : [id]
        const t = this.table(cls)
        for (const i of ids) t.delete(i)
        this.calls.push({method: 'remove', entity: cls.name, count: ids.length})
    }
}
