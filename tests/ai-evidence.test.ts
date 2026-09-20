import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { createAiEvidence } from '../src/application/ai-evidence'

describe('AI evidence IPC payload', () => {
  it('converts Vue reactive analysis state into a cloneable plain object', () => {
    const state = reactive({
      name: '$Recycle.Bin',
      parent: 'C:\\',
      size: 1024,
      isDirectory: true,
      classification: 'unclassified',
      source: '暂未确定',
      belongsTo: 'Windows 回收站',
      evidence: { pathSegments: ['c:', '$recycle.bin'], siblingNames: ['Windows', 'Users'], childNames: ['desktop.ini'], directoryShape: { sampledChildren: 1, directories: 0, files: 1, commonExtensions: [{ extension: '.ini', count: 1 }] } },
      relationship: { entityType: 'system' as const, entityName: 'Windows 回收站', entityKind: '系统组件', rootPath: 'C:\\$Recycle.Bin', role: { id: 'storage', label: '已删除文件存储' }, confidence: .99, evidence: ['位于卷根目录'] },
      relatedLocations: [{ path: 'D:\\$Recycle.Bin', reason: '同类目录', volume: 'D:' }],
      uiOnlyCallback: () => undefined
    })

    const payload = createAiEvidence(state)

    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload.name).toBe('$Recycle.Bin')
    expect(payload.evidence.siblingNames).toEqual(['Windows', 'Users'])
    expect(payload.evidence.childNames).toEqual(['desktop.ini'])
    expect(payload.belongsTo).toBe('Windows 回收站')
    expect(payload.evidence.relationship?.entityName).toBe('Windows 回收站')
    expect(payload).not.toHaveProperty('uiOnlyCallback')
  })
})
