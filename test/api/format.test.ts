import {describe, expect, it} from 'vitest'
import {formatUnits} from '../../src/server-extension/discovery'

describe('formatUnits', () => {
    it('scales by decimals as a plain string without trailing zeros', () => {
        expect(formatUnits(1_234_500_000_000_000_000_000n, 18)).toBe('1234.5')
        expect(formatUnits(1_000_000n, 6)).toBe('1')
        expect(formatUnits(1n, 18)).toBe('0.000000000000000001')
        expect(formatUnits(0n, 6)).toBe('0')
        expect(formatUnits(42n, 0)).toBe('42')
        expect(formatUnits(2n ** 256n - 1n, 18)).toBe('115792089237316195423570985008687907853269984665640564039457.584007913129639935')
    })
})
