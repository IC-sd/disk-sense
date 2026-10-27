import type { FileExplanation } from '../domain/desktop'
import { EVIDENCE_VERSION } from './ai-contract'

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
      version: EVIDENCE_VERSION,
      fileType: evidence.fileType && typeof evidence.fileType === 'object' ? {
        source: 'file-header', format: text(evidence.fileType.format), type: text(evidence.fileType.type),
        status: text(evidence.fileType.status), confidence: number(evidence.fileType.confidence),
        extension: text(evidence.fileType.extension), extensionConflict: Boolean(evidence.fileType.extensionConflict),
        bytesRead: number(evidence.fileType.bytesRead), prefixLimited: Boolean(evidence.fileType.prefixLimited),
        details: Array.isArray(evidence.fileType.details) ? evidence.fileType.details.slice(0, 4).map(String) : []
      } : null,
      observations: Array.isArray(evidence.observations) ? evidence.observations.slice(0, 8).map(item => ({
        id: text(item.id), source: text(item.source), confidence: number(item.confidence),
        extensionConflict: Boolean(item.extensionConflict), status: text(item.status), format: text(item.format)
      })) : [],
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
        : null,
      relationship: input.relationship && typeof input.relationship === 'object'
        ? {
            entityType: text(input.relationship.entityType),
            entityName: text(input.relationship.entityName),
            entityKind: text(input.relationship.entityKind),
            rootPath: text(input.relationship.rootPath),
            installLocation: text(input.relationship.installLocation),
            publisher: text(input.relationship.publisher),
            shortcutTarget: text(input.relationship.shortcutTarget),
            role: input.relationship.role && typeof input.relationship.role === 'object'
              ? { id: text(input.relationship.role.id), label: text(input.relationship.role.label), evidence: text(input.relationship.role.evidence) }
              : null,
            confidence: number(input.relationship.confidence),
            basis: text(input.relationship.basis),
            components: (input.relationship.components || []).slice(0, 8).map(component => ({
              name: text(component.entityName), rootPath: text(component.rootPath),
              evidence: (component.evidence || []).slice(0, 4).map(String)
            })),
            evidence: Array.isArray(input.relationship.evidence) ? input.relationship.evidence.slice(0, 8).map(String) : []
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
