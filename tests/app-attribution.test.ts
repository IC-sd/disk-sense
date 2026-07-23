import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop adapter is type-checked separately.
import { attribute, storageRelationship, findRelatedLocations } from '../desktop/app-attribution.cjs'

describe('application attribution', () => {
  it('identifies application data from path evidence', () => { expect(attribute('C:/Users/me/AppData/Local/Google/Chrome/User Data/Cache/a')?.id).toBe('chrome') })
  it('reports system disk relationship', () => { expect(storageRelationship('C:/Users/me/AppData/Local/npm-cache/x').systemDisk).toBe(true) })
  it('returns bounded existing locations for a known application', () => {
    const locations = findRelatedLocations('C:/Users/me/AppData/Local/Google/Chrome/User Data/Cache/a')
    expect(locations.length).toBeLessThanOrEqual(12)
    expect(locations.every((item: any) => item.path && item.volume)).toBe(true)
  })
})
