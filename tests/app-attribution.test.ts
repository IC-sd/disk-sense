import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop adapter is type-checked separately.
import { attribute, storageRelationship } from '../desktop/app-attribution.cjs'

describe('application attribution', () => {
  it('identifies application data from path evidence', () => { expect(attribute('C:/Users/me/AppData/Local/Google/Chrome/User Data/Cache/a')?.id).toBe('chrome') })
  it('reports system disk relationship', () => { expect(storageRelationship('C:/Users/me/AppData/Local/npm-cache/x').systemDisk).toBe(true) })
})
