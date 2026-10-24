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
  // A branch's changes (docs/CHANGES-PLAN.md §9.3, §9.6, §9.8): palette and context-menu commands, no view of their own.
  'sidestory.changes.nextFile',
  'sidestory.changes.prevFile',
  'sidestory.changes.nextUnexplained',
  'sidestory.changes.prevUnexplained',
  'sidestory.changes.openChange',
  'sidestory.changes.copyExplainPrompt',
  'sidestory.changes.dismissExplain',
  'sidestory.changes.copyUpdatePrompt',
  'sidestory.changes.copyChangePrompt',
  'sidestory.changes.markTrivial',
  'sidestory.changes.repinStep',
  'sidestory.changes.setBase',
  'sidestory.explainFile',
] as const;
