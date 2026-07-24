import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS desktop adapter is type-checked separately.
import { attribute, storageRelationship, findRelatedLocations } from '../desktop/app-attribution.cjs'

describe('application attribution', () => {
  it('identifies application data from path evidence', () => { expect(attribute('C:/Users/me/AppData/Local/Google/Chrome/User Data/Cache/a')?.id).toBe('chrome') })
  it('reports system disk relationship', () => { expect(storageRelationship('C:/Users/me/AppData/Local/npm-cache/x').systemDisk).toBe(true) })
  it('returns bounded existing locations for a known application', () => {
    const locations = findRelatedLocations('C:/Users/me/AppData/Local/Google/Chrome/User Data/Cache/a')
    expect(locations.length).toBeLessThanOrEqual(16)
    expect(locations.every((item: any) => item.path && item.volume)).toBe(true)
  })

  it('recognizes common communication, development and game data families', () => {
    expect(attribute('C:/Users/me/Documents/WeChat Files/account/Msg')?.id).toBe('wechat')
    expect(attribute('C:/Users/me/.m2/repository/org/example')?.id).toBe('maven')
    expect(attribute('D:/Steam/steamapps/common/game')?.id).toBe('steam')
    expect(attribute('C:/Users/me/AppData/Roaming/Code/User/settings.json')?.id).toBe('vscode')
  })

  it('keeps similar but unrelated names unclassified', () => {
    expect(attribute('D:/Photos/chrome-colored-wallpaper.jpg')).toBeNull()
    expect(attribute('D:/Notes/steam-engine.txt')).toBeNull()
  })
})
