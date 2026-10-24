// Shared by the bootstrap (dist/extension.cjs) and the full extension (dist/full.cjs); keep it tiny: the
// bootstrap bundles it.

/** Workspace state: this workspace has sidestories (true), or "Show Sidestories" asked for the view ('shown'). */
export const AVAILABLE_KEY = 'sidestory.available';

/** The webview view type VS Code persists for panel restore. */
export const PANEL_VIEW_TYPE = 'sidestory.explainer';

/** Every command contributed in package.json: the bootstrap registers each and routes it to the full extension. */
export const COMMANDS = [
  'sidestory.open',
  'sidestory.openAt',
  'sidestory.openInNewPanel',
  'sidestory.goToStep',
  'sidestory.showHere',
  'sidestory.statusOpen',
  'sidestory.showSidestories',
  'sidestory.copyAgentPrompt',
  'sidestory.tree.open',
  'sidestory.tree.filter',
  'sidestory.tree.clearFilter',
  'sidestory.tree.refresh',
  'sidestory.tree.revealInExplorer',
  'sidestory.tree.copyPath',
  'sidestory.nextStep',
  'sidestory.prevStep',
  'sidestory.pin',
  'sidestory.reanchor',
  'sidestory.revokeWidgetConsent',
  'sidestory.enableWidgets',
  'sidestory.checkWidgets',
  'sidestory.copyWidgetCheckCommand',
  'sidestory.addWidgetTypes',
  // The Changes view (docs/CHANGES-PLAN.md §9.8).
  'sidestory.showChanges',
  'sidestory.changes.open',
  'sidestory.changes.openDiff',
  'sidestory.changes.openDiffToSide',
  'sidestory.changes.openFile',
  'sidestory.changes.openFileToSide',
  'sidestory.changes.revealInExplorer',
  'sidestory.changes.copyPath',
  'sidestory.changes.copyRelativePath',
  'sidestory.changes.nextFile',
  'sidestory.changes.prevFile',
  'sidestory.changes.openAll',
  'sidestory.changes.refresh',
  'sidestory.changes.viewAsList',
  'sidestory.changes.viewAsTree',
  'sidestory.changes.collapseAll',
  'sidestory.changes.sort',
  'sidestory.changes.filter',
  'sidestory.changes.clearFilter',
  'sidestory.changes.includeUncommitted',
  'sidestory.changes.committedOnly',
  'sidestory.changes.pickBase',
  'sidestory.changes.pickRepository',
  'sidestory.changes.fetch',
  // Release 1b: the coverage layer (§9.6, §9.8) and Explain with Sidestory (§14.4).
  'sidestory.changes.openChange',
  'sidestory.changes.nextUnexplained',
  'sidestory.changes.prevUnexplained',
  'sidestory.changes.onlyUnexplained',
  'sidestory.changes.showAll',
  'sidestory.changes.openStep',
  'sidestory.changes.copyExplainPrompt',
  'sidestory.changes.dismissExplain',
  'sidestory.changes.copyUpdatePrompt',
  'sidestory.changes.copyChangePrompt',
  'sidestory.changes.markTrivial',
  'sidestory.explainFile',
] as const;
