const ANALYSIS_VERSION = 'disk-sense-analysis-3'
const PROMPT_VERSION = 'evidence-linked-2'
const EVIDENCE_VERSION = 3
const CONFIRMED_BASES = ['install-path', 'project-markers', 'known-signature', 'package-install-path', 'package-data-path', 'portable-manifest']
function currentVersions(value = {}) {
  return value.analysisVersion === ANALYSIS_VERSION && value.promptVersion === PROMPT_VERSION && value.evidenceVersion === EVIDENCE_VERSION
}
module.exports = { ANALYSIS_VERSION, PROMPT_VERSION, EVIDENCE_VERSION, CONFIRMED_BASES, currentVersions }
