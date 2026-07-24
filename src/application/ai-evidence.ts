function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function createAiEvidence(input: Partial<FileExplanation> & Record<string, unknown>) {
  const evidence = input.evidence || {}
  return {
    name: text(input?.name),
    parent: text(input?.parent),
    size: number(input?.size),
    fileCount: number(input?.fileCount),
    isDirectory: Boolean(input?.isDirectory),
    classification: text(input?.classification),
    source: text(input?.source),
    belongsTo: text(input?.belongsTo),
    what: text(input?.what),
    purpose: text(input?.purpose),
    handling: text(input?.handling),
    confidence: number(input?.confidence),
    risk: text(input?.risk),
    evidence: {
      pathSegments: Array.isArray(evidence.pathSegments) ? evidence.pathSegments.slice(-8).map(String) : [],
      siblingNames: Array.isArray(evidence.siblingNames) ? evidence.siblingNames.slice(0, 40).map(String) : [],
      childNames: Array.isArray(evidence.childNames) ? evidence.childNames.slice(0, 60).map(String) : [],
      directoryShape: evidence.directoryShape && typeof evidence.directoryShape === 'object'
        ? {
            sampledChildren: number(evidence.directoryShape.sampledChildren),
            directories: number(evidence.directoryShape.directories),
            files: number(evidence.directoryShape.files),
            commonExtensions: Array.isArray(evidence.directoryShape.commonExtensions)
              ? evidence.directoryShape.commonExtensions.slice(0, 8).map(item => ({
                  extension: text(item?.extension),
                  count: number(item?.count)
                }))
              : []
          }
        : null
    },
    contentPreview: text(input?.contentPreview),
    relatedLocations: Array.isArray(input?.relatedLocations)
      ? input.relatedLocations.slice(0, 12).map(item => ({
          path: text(item?.path),
          reason: text(item?.reason),
          volume: text(item?.volume)
        }))
      : []
  }
}
import type { FileExplanation } from '../domain/desktop'
