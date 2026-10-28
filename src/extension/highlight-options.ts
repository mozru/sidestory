// The highlighting settings in effect for a sidestory: the reader's own setting, then the step's (`dim` only), then
// the sidestory's `highlight` in its manifest, then the default. Manifest values are validated in parseHighlight.
import * as vscode from 'vscode';
import { HOVER_PREVIEW_MODES, LIMITS, type HighlightOptions, type HoverPreviewMode } from '../core/manifest.ts';

export interface EffectiveHighlight {
  dim: boolean;
  clickSeconds: number;
  clickFrame: boolean;
  hoverPreview: HoverPreviewMode;
}

export const HIGHLIGHT_DEFAULTS: EffectiveHighlight = { dim: true, clickSeconds: 1.5, clickFrame: true, hoverPreview: 'card' };

const SETTINGS: Record<keyof EffectiveHighlight, string> = {
  dim: 'dimUnfocused',
  clickSeconds: 'clickHighlightSeconds',
  clickFrame: 'clickFrame',
  hoverPreview: 'hoverPreview',
};

/** A value of the option's type, or undefined. */
const VALID: { [K in keyof EffectiveHighlight]: (v: unknown) => EffectiveHighlight[K] | undefined } = {
  dim: (v) => (typeof v === 'boolean' ? v : undefined),
  clickSeconds: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, LIMITS.clickSeconds) : undefined),
  clickFrame: (v) => (typeof v === 'boolean' ? v : undefined),
  hoverPreview: (v) => HOVER_PREVIEW_MODES.find((m) => m === v),
};

/** The reader's own value for a setting (user, workspace or folder settings; none is language-overridable), not the default. */
function explicit(key: keyof EffectiveHighlight): unknown[] {
  const i = vscode.workspace.getConfiguration('sidestory').inspect(SETTINGS[key]);
  return i ? [i.workspaceFolderValue, i.workspaceValue, i.globalValue] : [];
}

/** Each option as it applies: the reader's setting, then `step` (dim), then `story`, then the default. */
export function effectiveHighlight(story?: HighlightOptions, step?: { dim?: boolean }): EffectiveHighlight {
  const pick = <K extends keyof EffectiveHighlight>(key: K, ...from: unknown[]): EffectiveHighlight[K] => {
    for (const v of [...explicit(key), ...from]) {
      const ok = VALID[key](v);
      if (ok !== undefined) return ok;
    }
    return HIGHLIGHT_DEFAULTS[key];
  };
  return {
    dim: pick('dim', step?.dim, story?.dim),
    clickSeconds: pick('clickSeconds', story?.clickSeconds),
    clickFrame: pick('clickFrame', story?.clickFrame),
    hoverPreview: pick('hoverPreview', story?.hoverPreview),
  };
}

