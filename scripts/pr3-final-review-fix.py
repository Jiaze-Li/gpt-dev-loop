from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


# P1: CLI wait without --status must wait for a terminal state.
replace_once(
    'bin/supergpt.js',
    "      predicate: (s) => (opts.targetStatus ? s.workflowStatus === opts.targetStatus : true),",
    "      predicate: (s) => (opts.targetStatus ? s.workflowStatus === opts.targetStatus : ['DONE', 'HUMAN_REQUIRED', 'FAILED', 'TIMEOUT', 'STALLED', 'STOPPED'].includes(s.workflowStatus)),",
)


# P2: lifecycle ownership must accept the exact path generated for any
# centrally validated workflow ID, while keeping generic discovery conservative.
replace_once(
    'src/orchestrator/workflowLifecycle.js',
    """export function isSuperGptOwnedWorktree(targetPath, root = SUPERGPT_WORKTREE_ROOT) {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);

  // Must be strictly inside the SuperGPT worktrees root
  if (!resolvedTarget.startsWith(resolvedRoot) || resolvedTarget === resolvedRoot) {
    return false;
  }

  // Must follow SuperGPT naming convention containing -wf-agy- or -wf-
  const basename = path.basename(resolvedTarget);
  return /-wf-(agy-)?[0-9a-fA-F-]+/.test(basename);
}""",
    """export function isSuperGptOwnedWorktree(targetPath, root = SUPERGPT_WORKTREE_ROOT, workflowId = null) {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);

  // Must be strictly inside the SuperGPT worktrees root. path.relative keeps
  // sibling prefixes (for example worktrees-other) outside the trust boundary.
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }

  const basename = path.basename(resolvedTarget);

  // When the lifecycle manager knows the workflow ID, apply the same central
  // validation used by createWorkflowWorktree() and require the exact suffix
  // that creator constructs: <repo-basename>-<workflowId>.
  if (workflowId !== null && workflowId !== undefined) {
    try {
      validateWorkflowId(workflowId);
    } catch {
      return false;
    }
    return basename.length > workflowId.length + 1 && basename.endsWith(`-${workflowId}`);
  }

  // Generic discovery remains conservative for legacy/default generated names.
  return /-wf-(agy-)?[0-9a-fA-F-]+/.test(basename);
}""",
)

p = Path('src/orchestrator/workflowLifecycle.js')
text = p.read_text()
old_manager_check = 'if (!isSuperGptOwnedWorktree(worktreePath, this.root)) {'
if text.count(old_manager_check) != 2:
    raise SystemExit(f'workflowLifecycle.js: expected two manager ownership checks, found {text.count(old_manager_check)}')
text = text.replace(old_manager_check, 'if (!isSuperGptOwnedWorktree(worktreePath, this.root, this.workflowId)) {')
p.write_text(text)


# P2: global frontend installation must be transactional across all files the
# installer or the Claude/Codex registration CLIs mutate.
replace_once(
    'bin/install-plugin.js',
    """function renderAgySkill(commonPolicy) {
  return `---\\nname: supergpt\\ndescription: Shared SuperGPT frontend launcher contract.\\n---\\n\\n${String(commonPolicy).trim()}\\n`;
}

async function readAgyConfig(mcpConfigFile) {""",
    """function renderAgySkill(commonPolicy) {
  return `---\\nname: supergpt\\ndescription: Shared SuperGPT frontend launcher contract.\\n---\\n\\n${String(commonPolicy).trim()}\\n`;
}

async function snapshotFileState(filePath) {
  try {
    return { existed: true, content: await readFile(filePath) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { existed: false, content: null };
    throw err;
  }
}

async function restoreFileState(filePath, snapshot) {
  // Remove any partial replacement first, including an unexpected directory
  // or symlink at a path that used to be absent or a regular file.
  await rm(filePath, { recursive: true, force: true });
  if (!snapshot?.existed) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, snapshot.content);
}

async function restoreFileStates(snapshots) {
  const errors = [];
  for (const [filePath, snapshot] of snapshots) {
    try {
      await restoreFileState(filePath, snapshot);
    } catch (err) {
      errors.push(`${filePath}: ${err?.message || err}`);
    }
  }
  return errors;
}

async function readAgyConfig(mcpConfigFile) {""",
)

replace_once(
    'bin/install-plugin.js',
    """  let claudeRegistered = false;
  let codexRegistered = false;
  try {
    registerClaudeMcp(execFileSync, nodeBin, mcpBin);
    claudeRegistered = true;
    registerCodexMcp(execFileSync, nodeBin, mcpBin);
    codexRegistered = true;

    await mkdir(agyConfigDir, { recursive: true });
    await mkdir(agySkillTargetDir, { recursive: true });

    agyConfig.mcpServers[MCP_NAME] = { command: nodeBin, args: [mcpBin] };
    await writeFile(mcpConfigFile, `${JSON.stringify(agyConfig, null, 2)}\\n`, 'utf8');
    await writeFile(agyPolicyFile, renderAgySkill(commonPolicy), 'utf8');

    await upsertManagedPolicy(claudePolicyFile, commonPolicy);
    await upsertManagedPolicy(codexPolicyFile, commonPolicy);
  } catch (err) {
    if (codexRegistered) removeCodexMcp(execFileSync);
    if (claudeRegistered) removeClaudeMcp(execFileSync);
    throw err;
  }""",
    """  const claudeMcpConfigFile = path.join(homeDir, '.claude.json');
  const codexMcpConfigFile = path.join(homeDir, '.codex', 'config.toml');
  const transactionalPaths = [
    mcpConfigFile,
    agyPolicyFile,
    claudePolicyFile,
    codexPolicyFile,
    claudeMcpConfigFile,
    codexMcpConfigFile,
  ];
  const snapshots = new Map();
  for (const filePath of transactionalPaths) {
    snapshots.set(filePath, await snapshotFileState(filePath));
  }

  // Validate existing managed policy blocks before the first MCP registration
  // mutates frontend state.
  for (const policyPath of [claudePolicyFile, codexPolicyFile]) {
    const snapshot = snapshots.get(policyPath);
    if (snapshot?.existed) stripManagedPolicy(snapshot.content.toString('utf8'));
  }

  try {
    registerClaudeMcp(execFileSync, nodeBin, mcpBin);
    registerCodexMcp(execFileSync, nodeBin, mcpBin);

    await mkdir(agyConfigDir, { recursive: true });
    await mkdir(agySkillTargetDir, { recursive: true });

    agyConfig.mcpServers[MCP_NAME] = { command: nodeBin, args: [mcpBin] };
    await writeFile(mcpConfigFile, `${JSON.stringify(agyConfig, null, 2)}\\n`, 'utf8');
    await writeFile(agyPolicyFile, renderAgySkill(commonPolicy), 'utf8');

    await upsertManagedPolicy(claudePolicyFile, commonPolicy);
    await upsertManagedPolicy(codexPolicyFile, commonPolicy);
  } catch (err) {
    // Registration helpers remove/replace existing entries. Remove any partial
    // new entry, then restore exact pre-install bytes for every frontend file.
    removeCodexMcp(execFileSync);
    removeClaudeMcp(execFileSync);
    const rollbackErrors = await restoreFileStates(snapshots);
    if (rollbackErrors.length > 0) {
      err.rollbackErrors = rollbackErrors;
      err.message = `${err.message} (rollback incomplete: ${rollbackErrors.join('; ')})`;
    }
    throw err;
  }""",
)

print('PR3 final review fixes applied')
