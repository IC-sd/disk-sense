import { describe, expect, it } from 'vitest'
import { createAgentContext } from '../src/application/agent-context'
import { exportMemories } from '../src/application/memory-markdown'

describe('agent context', () => {
  it('defaults to metadata-only and no mutation', () => { const context=createAgentContext({scope:['C:/Users']}); expect(context.permissions.readContent).toBe(false); expect(context.permissions.mutateFiles).toBe(false) })
  it('exports user memory as markdown', () => { expect(exportMemories([{id:'1',subject:'Downloads',content:'Keep for 30 days',tags:['retention'],source:'user',createdAt:'',updatedAt:'',confidence:1}])).toContain('# Downloads') })
})
