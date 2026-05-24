import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  isGitRepository,
  createWorktree,
  commitAndMergeWorktree,
  removeWorktree,
  pruneOrphanedWorktrees,
} from '../src/nexus/worktree.js'

function runCommand(cwd: string, cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command ${cmd} ${args.join(' ')} failed with code ${code}`))
    })
  })
}

test('Git Worktree Lifecycle Integration Test', async () => {
  // Create a temporary repository inside the project workspace directory
  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  
  const testRepoDir = join(babelODir, `test-repo-${Date.now()}`)
  mkdirSync(testRepoDir)
  
  try {
    // 1. Initialize git repo
    await runCommand(testRepoDir, 'git', ['init'])
    await runCommand(testRepoDir, 'git', ['config', 'user.name', 'Test User'])
    await runCommand(testRepoDir, 'git', ['config', 'user.email', 'test@example.com'])
    
    // 2. Commit a dummy file to have a commit history (required by worktree add)
    const dummyFile = join(testRepoDir, 'dummy.txt')
    writeFileSync(dummyFile, 'hello', 'utf8')
    await runCommand(testRepoDir, 'git', ['add', '.'])
    await runCommand(testRepoDir, 'git', ['commit', '-m', 'initial commit'])
    
    // 3. Verify it is detected as a Git repo
    const isGit = await isGitRepository(testRepoDir)
    assert.equal(isGit, true)
    
    // 4. Create a worktree
    const taskId = 'test-worktree-task-123'
    const worktreePath = await createWorktree(testRepoDir, taskId)
    
    assert.equal(existsSync(worktreePath), true)
    
    // 5. Modify files in the worktree
    const newFilePath = join(worktreePath, 'new_file.txt')
    writeFileSync(newFilePath, 'changes from worktree', 'utf8')
    
    // 6. Commit and merge the worktree changes back to the main workspace
    const commitHash = await commitAndMergeWorktree(
      testRepoDir,
      worktreePath,
      taskId,
      'Add new file from worktree',
    )
    
    assert.ok(commitHash)
    
    // 7. Verify the changes are merged back to the main workspace
    const mergedFile = join(testRepoDir, 'new_file.txt')
    assert.equal(existsSync(mergedFile), true)
    assert.equal(readFileSync(mergedFile, 'utf8'), 'changes from worktree')
    
    // 8. Clean up the worktree
    await removeWorktree(testRepoDir, worktreePath, taskId)
    assert.equal(existsSync(worktreePath), false)
    
    // Test prune functions
    await pruneOrphanedWorktrees(testRepoDir)
  } finally {
    // Delete the temporary test repo
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

test('commitAndMergeWorktree reports conflicting files on cherry-pick failure', async () => {
  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  
  const testRepoDir = join(babelODir, `test-repo-conflict-${Date.now()}`)
  mkdirSync(testRepoDir)
  
  try {
    // 1. Initialize git repo
    await runCommand(testRepoDir, 'git', ['init'])
    await runCommand(testRepoDir, 'git', ['config', 'user.name', 'Test User'])
    await runCommand(testRepoDir, 'git', ['config', 'user.email', 'test@example.com'])
    
    // 2. Commit initial file
    const fileToConflict = join(testRepoDir, 'conflict.txt')
    writeFileSync(fileToConflict, 'line 1\nline 2\nline 3\n', 'utf8')
    await runCommand(testRepoDir, 'git', ['add', '.'])
    await runCommand(testRepoDir, 'git', ['commit', '-m', 'initial commit'])
    
    // 3. Create isolated worktree
    const taskId = 'test-worktree-conflict-task'
    const worktreePath = await createWorktree(testRepoDir, taskId)
    
    // 4. Modify conflict.txt inside the worktree (commitAndMergeWorktree will commit it)
    const worktreeConflictFile = join(worktreePath, 'conflict.txt')
    writeFileSync(worktreeConflictFile, 'line 1\nline 2 modified in worktree\nline 3\n', 'utf8')
    
    // 5. Modify conflict.txt differently in the parent repository at the same line, and commit
    writeFileSync(fileToConflict, 'line 1\nline 2 modified in parent\nline 3\n', 'utf8')
    await runCommand(testRepoDir, 'git', ['add', '.'])
    await runCommand(testRepoDir, 'git', ['commit', '-m', 'parent modification'])
    
    // 6. Now calling commitAndMergeWorktree should fail due to conflict
    await assert.rejects(
      async () => {
        await commitAndMergeWorktree(
          testRepoDir,
          worktreePath,
          taskId,
          'Attempt conflict merge',
        )
      },
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('Cherry-pick failed with conflicts'))
        assert.ok(err.message.includes('conflict.txt'))
        return true
      }
    )
    
    // 7. Verify the parent repository state is clean (CHERRY_PICK_HEAD does not exist)
    const cherryPickHeadPath = join(testRepoDir, '.git', 'CHERRY_PICK_HEAD')
    assert.equal(existsSync(cherryPickHeadPath), false)
    
    // 8. Clean up the worktree
    await removeWorktree(testRepoDir, worktreePath, taskId)
    assert.equal(existsSync(worktreePath), false)
  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

test('commitAndMergeWorktree stages explicit changed paths and merges new files', async () => {
  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }

  const testRepoDir = join(babelODir, `test-repo-pathspec-${Date.now()}`)
  mkdirSync(testRepoDir)

  try {
    await runCommand(testRepoDir, 'git', ['init'])
    await runCommand(testRepoDir, 'git', ['config', 'user.name', 'Test User'])
    await runCommand(testRepoDir, 'git', ['config', 'user.email', 'test@example.com'])

    const trackedFile = join(testRepoDir, 'tracked.txt')
    writeFileSync(trackedFile, 'before', 'utf8')
    await runCommand(testRepoDir, 'git', ['add', '.'])
    await runCommand(testRepoDir, 'git', ['commit', '-m', 'initial commit'])

    const taskId = 'test-worktree-pathspec-task'
    const worktreePath = await createWorktree(testRepoDir, taskId)
    writeFileSync(join(worktreePath, 'tracked.txt'), 'after', 'utf8')
    writeFileSync(join(worktreePath, 'new-file.txt'), 'new content', 'utf8')

    const commitHash = await commitAndMergeWorktree(
      testRepoDir,
      worktreePath,
      taskId,
      'Pathspec merge',
    )

    assert.ok(commitHash)
    assert.equal(readFileSync(join(testRepoDir, 'tracked.txt'), 'utf8'), 'after')
    assert.equal(readFileSync(join(testRepoDir, 'new-file.txt'), 'utf8'), 'new content')

    await removeWorktree(testRepoDir, worktreePath, taskId)
    assert.equal(existsSync(worktreePath), false)
  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})
