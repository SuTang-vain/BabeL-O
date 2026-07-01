#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsRoot = join(root, 'docs', 'nexus')
const docsDirectoryRoot = join(root, 'docs')
const referenceRoot = join(docsRoot, 'reference')
const archiveRoot = join(docsRoot, 'archive')
const proposalsRoot = join(docsRoot, 'proposals')
const historyRoot = join(docsRoot, 'history')
const decisionsRoot = join(docsRoot, 'decisions')
const activeRoot = join(docsRoot, 'active')
const releasesRoot = join(root, 'docs', 'releases')
const guidesRoot = join(docsDirectoryRoot, 'guides')
const referenceReadmePath = join(referenceRoot, 'README.md')
const referenceReadme = await readFile(referenceReadmePath, 'utf8')
const archiveReadmePath = join(archiveRoot, 'README.md')
const archiveReadme = await readFile(archiveReadmePath, 'utf8')
const proposalsReadmePath = join(proposalsRoot, 'README.md')
const proposalsReadme = await readFile(proposalsReadmePath, 'utf8')
const historyReadmePath = join(historyRoot, 'README.md')
const historyReadme = await readFile(historyReadmePath, 'utf8')
const decisionsReadmePath = join(decisionsRoot, 'README.md')
const decisionsReadme = await readFile(decisionsReadmePath, 'utf8')
const releasesReadmePath = join(releasesRoot, 'README.md')
const releasesReadme = await readFile(releasesReadmePath, 'utf8')
const referenceFiles = (await readdir(referenceRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const archiveFiles = (await readdir(archiveRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const releaseFiles = (await readdir(releasesRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const proposalFiles = (await readdir(proposalsRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const historyFiles = (await readdir(historyRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const decisionFiles = (await readdir(decisionsRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const activeFiles = (await readdir(activeRoot))
  .filter(name => name.endsWith('.md'))
  .sort()
const guidesFiles = existsSync(guidesRoot)
  ? await listMarkdownFiles(guidesRoot)
  : []
const allowedStates = new Set([
  'Active Plan',
  'Partially Landed',
  'Closed Reference',
  'Superseded',
  'Draft',
  'Index',
  'Guide',
  'History',
  'Accepted',
])
const allowedReferenceStates = new Set(['Active Plan', 'Closed Reference', 'Index', 'Guide'])
const allowedProposalStates = new Set(['Draft', 'Partially Landed'])
const allowedHistoryStates = new Set(['History', 'Index'])
const allowedDecisionStates = new Set(['Accepted', 'Index'])
const failures = []
const referenceBodyCjkReports = []

checkReferenceIndexCoverage()
checkReferenceIndexRows()
checkArchiveIndexCoverage()
checkDirectoryIndexCoverage({
  files: proposalFiles,
  readme: proposalsReadme,
  readmePath: proposalsReadmePath,
  reason: 'proposal_not_indexed',
})
checkDirectoryIndexCoverage({
  files: historyFiles,
  readme: historyReadme,
  readmePath: historyReadmePath,
  reason: 'history_not_indexed',
})
checkDirectoryIndexCoverage({
  files: decisionFiles,
  readme: decisionsReadme,
  readmePath: decisionsReadmePath,
  reason: 'decision_not_indexed',
})
checkReleaseIndexCoverage()
await checkDocsRootPolicy()
await checkReferenceDocuments()
await checkLifecycleDocuments()
await checkMarkdownLinks()
checkArchiveReferencesFromTodo()
checkStaleSymbolReferences()

console.log(JSON.stringify({
  type: 'nexus_docs_check',
  referenceFileCount: referenceFiles.length,
  proposalFileCount: proposalFiles.length,
  historyFileCount: historyFiles.length,
  decisionFileCount: decisionFiles.length,
  archiveFileCount: archiveFiles.length,
  releaseFileCount: releaseFiles.length,
  guidesFileCount: guidesFiles.length,
  staleSymbolReferences: failures.filter(f => f.reason === 'stale_symbol_reference').length,
  docsRootPolicy: 'docs root: README/DEVELOPMENT only; external user docs in docs/guides/; planning in docs/nexus',
  referenceBodyCjk: {
    filesWithCjkBeforeChineseSummary: referenceBodyCjkReports.length,
    top: referenceBodyCjkReports
      .sort((a, b) => b.cjkChars - a.cjkChars)
      .slice(0, 10),
  },
  allowedStates: [...allowedStates],
  failureCount: failures.length,
  failures,
}, null, 2))

if (failures.length > 0) {
  process.exitCode = 1
}

function checkReferenceIndexCoverage() {
  for (const fileName of referenceFiles) {
    if (fileName === 'README.md') continue
    const link = `./${fileName}`
    if (!referenceReadme.includes(link)) {
      failures.push({
        file: relative(root, referenceReadmePath),
        reason: 'reference_not_indexed',
        target: fileName,
      })
    }
  }
}

function checkReferenceIndexRows() {
  const rows = referenceReadme
    .split('\n')
    .filter(line => line.startsWith('| [') && line.includes('](./'))
  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim()).filter(Boolean)
    if (cells.length < 3) {
      failures.push({
        file: relative(root, referenceReadmePath),
        reason: 'malformed_reference_index_row',
        row,
      })
      continue
    }
    const state = cells[1].replace(/`/g, '')
    if (!allowedStates.has(state)) {
      failures.push({
        file: relative(root, referenceReadmePath),
        reason: 'invalid_reference_state',
        state,
        row,
      })
    }
    if (state === 'Superseded') {
      failures.push({
        file: relative(root, referenceReadmePath),
        reason: 'superseded_reference_should_be_archived',
        row,
      })
    }
  }
}

function checkArchiveIndexCoverage() {
  for (const fileName of archiveFiles) {
    if (fileName === 'README.md') continue
    const link = `./${fileName}`
    if (!archiveReadme.includes(link)) {
      failures.push({
        file: relative(root, archiveReadmePath),
        reason: 'archive_not_indexed',
        target: fileName,
      })
    }
  }
}

function checkDirectoryIndexCoverage({ files, readme, readmePath, reason }) {
  for (const fileName of files) {
    if (fileName === 'README.md') continue
    const link = `./${fileName}`
    if (!readme.includes(link)) {
      failures.push({
        file: relative(root, readmePath),
        reason,
        target: fileName,
      })
    }
  }
}

function checkReleaseIndexCoverage() {
  for (const fileName of releaseFiles) {
    if (fileName === 'README.md') continue
    const link = `./${fileName}`
    if (!releasesReadme.includes(link)) {
      failures.push({
        file: relative(root, releasesReadmePath),
        reason: 'release_not_indexed',
        target: fileName,
      })
    }
  }
}

async function checkDocsRootPolicy() {
  const allowedRootFiles = new Set([
    'README.md',
    'DEVELOPMENT.md',
    'DEVELOPMENT.zh-CN.md',
  ])
  const entries = await readdir(docsDirectoryRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    if (allowedRootFiles.has(entry.name)) continue
    failures.push({
      file: relative(root, join(docsDirectoryRoot, entry.name)),
      reason: 'unexpected_docs_root_markdown',
    })
  }
}

async function checkReferenceDocuments() {
  for (const fileName of referenceFiles) {
    if (fileName === 'README.md') continue
    const filePath = join(referenceRoot, fileName)
    const text = await readFile(filePath, 'utf8')
    const relativePath = relative(root, filePath)
    const isTemplate = fileName === 'REFERENCE_TEMPLATE.md'
    if (!isTemplate && !hasIndexedState(fileName)) {
      failures.push({
        file: relativePath,
        reason: 'missing_index_state',
      })
    }
    if (!isTemplate && !/^>\s*State:/m.test(text)) {
      failures.push({
        file: relativePath,
        reason: 'missing_reference_state_header',
      })
    }
    if (!isTemplate) {
      const state = getState(text)
      if (!allowedReferenceStates.has(state)) {
        failures.push({
          file: relativePath,
          reason: 'invalid_reference_lifecycle_state',
          state,
        })
      }
    }
    if (isTemplate) {
      for (const required of ['> State:', '> Track:', '> Priority:', '> Source of truth:', '## 中文概述']) {
        if (!text.includes(required)) {
          failures.push({
            file: relativePath,
            reason: 'template_missing_required_section',
            required,
          })
        }
      }
      continue
    }
    if (!text.includes('## 中文概述')) {
      failures.push({
        file: relativePath,
        reason: 'reference_missing_chinese_summary',
      })
    }
    if (!fileName.endsWith('-index.md') && !/^>\s*Governance:/m.test(text)) {
      failures.push({
        file: relativePath,
        reason: 'missing_reference_governance_header',
      })
    }
    const bodyBeforeChineseSummary = text.split(/^## 中文概述/m)[0] ?? text
    const cjkChars = countCjkOutsideInlineCode(bodyBeforeChineseSummary)
    if (cjkChars > 0) {
      referenceBodyCjkReports.push({
        file: relativePath,
        cjkChars,
      })
    }
  }
}

async function checkLifecycleDocuments() {
  await checkDocumentsInDirectory({
    directory: proposalsRoot,
    files: proposalFiles,
    allowed: allowedProposalStates,
    reasonPrefix: 'proposal',
  })
  await checkDocumentsInDirectory({
    directory: historyRoot,
    files: historyFiles,
    allowed: allowedHistoryStates,
    reasonPrefix: 'history',
  })
  await checkDocumentsInDirectory({
    directory: decisionsRoot,
    files: decisionFiles,
    allowed: allowedDecisionStates,
    reasonPrefix: 'decision',
  })
}

async function checkDocumentsInDirectory({ directory, files, allowed, reasonPrefix }) {
  for (const fileName of files) {
    if (fileName === 'README.md') continue
    const filePath = join(directory, fileName)
    const text = await readFile(filePath, 'utf8')
    const state = getState(text)
    if (!state) {
      failures.push({
        file: relative(root, filePath),
        reason: `${reasonPrefix}_missing_state_header`,
      })
      continue
    }
    if (!allowed.has(state)) {
      failures.push({
        file: relative(root, filePath),
        reason: `${reasonPrefix}_invalid_lifecycle_state`,
        state,
      })
    }
  }
}

function hasIndexedState(fileName) {
  const escaped = escapeRegExp(fileName)
  const rowPattern = new RegExp(`\\| \\[[^\\]]+\\]\\(\\./${escaped}\\) \\| ([^|]+) \\|`)
  const match = rowPattern.exec(referenceReadme)
  if (!match) return false
  return allowedStates.has(match[1].trim().replace(/`/g, ''))
}

function getState(text) {
  const match = /^>\s*State:\s*(.+)$/m.exec(text)
  return match?.[1]?.trim() ?? ''
}

async function checkMarkdownLinks() {
  const docs = await listMarkdownFiles(docsDirectoryRoot)
  for (const filePath of docs) {
    const text = await readFile(filePath, 'utf8')
    const linkPattern = /\[([^\]]*)]\(([^)]+\.md(?:#[^)]+)?)\)/g
    for (const match of text.matchAll(linkPattern)) {
      const label = match[1].trim()
      const rawTarget = match[2].split('#')[0]
      if (/^[a-z]+:|^\//i.test(rawTarget)) continue
      const targetPath = normalize(join(dirname(filePath), rawTarget))
      if (!existsSync(targetPath)) {
        failures.push({
          file: relative(root, filePath),
          reason: 'missing_markdown_link_target',
          target: rawTarget,
          resolved: relative(root, targetPath),
        })
      }
      const labelFileName = label.split('/').pop()
      const targetFileName = rawTarget.split('/').pop()
      if (label.endsWith('.md') && labelFileName !== targetFileName) {
        failures.push({
          file: relative(root, filePath),
          reason: 'markdown_link_label_target_mismatch',
          label,
          target: rawTarget,
        })
      }
    }
  }
}

function checkArchiveReferencesFromTodo() {
  const todoPath = join(docsRoot, 'TODO.md')
  if (!existsSync(todoPath)) return
  const todo = readFileSync(todoPath, 'utf8')
  const archiveLinkPattern = /\]\((\.\/archive\/[^)]+\.md(?:#[^)]+)?)\)/g
  for (const match of todo.matchAll(archiveLinkPattern)) {
    failures.push({
      file: relative(root, todoPath),
      reason: 'todo_links_archive_doc',
      target: match[1],
    })
  }
}

function checkStaleSymbolReferences() {
  // Removed symbols (e.g. the TS TUI `bbl chat`, removed in v0.3.7) must not
  // appear as current in non-historical docs. A mention is allowed only when
  // its paragraph carries a removal/legacy marker, so historical context
  // remains expressible. Scans active/, guides/, reference/, proposals/,
  // decisions/ plus top-level current docs. Excludes archive/, releases/, history/,
  // WORK_LOG.md, DONE.md — historical surfaces where removed symbols may
  // legitimately appear as prior context. To track a new removed symbol,
  // append to staleSymbols.
  const removalMarker = /移除|已于|不再|legacy|removed|历史|废弃|retired|superseded|超越|v0\.3\.7|旧 TS TUI|no longer/i
  const staleSymbols = [
    {
      term: 'bbl chat',
      hint: 'bbl chat (TS TUI) was removed in v0.3.7; bbl go is the sole production TUI. Reframe to bbl go / bbl run, or annotate the paragraph with a removal marker (e.g. v0.3.7 移除 / 旧 TS TUI / legacy).',
    },
  ]
  const scanFiles = [
    join(docsRoot, 'README.md'),
    join(docsRoot, 'TODO.md'),
    join(docsRoot, 'PROJECT_IDENTITY.md'),
    join(docsRoot, 'PHASE_9_DECISION.md'),
  ]
  for (const fileName of activeFiles) scanFiles.push(join(activeRoot, fileName))
  for (const filePath of guidesFiles) scanFiles.push(filePath)
  for (const fileName of referenceFiles) scanFiles.push(join(referenceRoot, fileName))
  for (const fileName of proposalFiles) scanFiles.push(join(proposalsRoot, fileName))
  for (const fileName of decisionFiles) scanFiles.push(join(decisionsRoot, fileName))
  for (const filePath of scanFiles) {
    if (!existsSync(filePath)) continue
    const text = readFileSync(filePath, 'utf8')
    const lines = text.split('\n')
    let para = []
    let paraStart = 0
    const flush = () => {
      if (para.length === 0) return
      const paraText = para.join('\n')
      for (const symbol of staleSymbols) {
        if (paraText.includes(symbol.term) && !removalMarker.test(paraText)) {
          const hitIdx = para.findIndex(line => line.includes(symbol.term))
          failures.push({
            file: relative(root, filePath),
            reason: 'stale_symbol_reference',
            symbol: symbol.term,
            line: paraStart + hitIdx + 1,
            excerpt: para[hitIdx].slice(0, 140),
            hint: symbol.hint,
          })
        }
      }
      para = []
    }
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        flush()
      } else {
        if (para.length === 0) paraStart = i
        para.push(lines[i])
      }
    }
    flush()
  }
}

async function listMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countCjkOutsideInlineCode(value) {
  const withoutFencedBlocks = value.replace(/```[\s\S]*?```/g, '')
  const withoutInlineCode = withoutFencedBlocks.replace(/`[^`\n]*`/g, '')
  return (withoutInlineCode.match(/[\u3400-\u9fff]/g) ?? []).length
}
