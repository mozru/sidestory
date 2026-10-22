// Theme variables the webview reads, for the browser harness. Values approximate VS Code's
// Dark Modern, Light Modern and High Contrast themes; the end-to-end tests use the real ones.
export type ThemeName = 'dark' | 'light' | 'hc';

const shared = {
  'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  'font-size': '13px',
  'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
};

export const THEMES: Record<ThemeName, { bodyClass: string; vars: Record<string, string> }> = {
  dark: {
    bodyClass: 'vscode-dark',
    vars: {
      ...shared,
      'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
      'panel-border': '#2b2b2b', 'editorGroup-border': '#ffffff17', focusBorder: '#0078d4', contrastActiveBorder: 'transparent',
      'list-hoverBackground': '#2a2d2e', 'list-inactiveSelectionBackground': '#37373d',
      'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'dropdown-border': '#3c3c3c', 'input-border': '#3c3c3c',
      'inputValidation-errorBackground': '#5a1d1d', 'inputValidation-errorBorder': '#be1100',
      'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
      'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
      'widget-shadow': '#0000005c', 'textLink-foreground': '#4daafc', 'textLink-activeForeground': '#4daafc',
      'textCodeBlock-background': '#2b2b2b', 'textBlockQuote-background': '#2b2b2b', 'editorWidget-background': '#202020',
      'editorWarning-foreground': '#cca700', 'editorError-foreground': '#f14c4c', 'editorInfo-foreground': '#3794ff',
      'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-yellow': '#cca700', 'charts-orange': '#d18616', 'charts-purple': '#b180d7', 'charts-red': '#f14c4c',
      'codeExplainer-focusBorder': '#0078d4', 'codeExplainer-staleForeground': '#cca700', 'codeExplainer-lostForeground': '#f14c4c',
    },
  },
  light: {
    bodyClass: 'vscode-light',
    vars: {
      ...shared,
      'editor-background': '#ffffff', 'editor-foreground': '#3b3b3b', foreground: '#3b3b3b', descriptionForeground: '#3b3b3b',
      'panel-border': '#e5e5e5', 'editorGroup-border': '#e5e5e5', focusBorder: '#005fb8', contrastActiveBorder: 'transparent',
      'list-hoverBackground': '#f2f2f2', 'list-inactiveSelectionBackground': '#e4e6f1',
      'dropdown-background': '#ffffff', 'dropdown-foreground': '#3b3b3b', 'dropdown-border': '#cecece', 'input-border': '#cecece',
      'inputValidation-errorBackground': '#f2dede', 'inputValidation-errorBorder': '#be1100',
      'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8',
      'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc',
      'widget-shadow': '#00000029', 'textLink-foreground': '#005fb8', 'textLink-activeForeground': '#005fb8',
      'textCodeBlock-background': '#f8f8f8', 'textBlockQuote-background': '#f8f8f8', 'editorWidget-background': '#f8f8f8',
      'editorWarning-foreground': '#bf8803', 'editorError-foreground': '#e51400', 'editorInfo-foreground': '#1a85ff',
      'charts-blue': '#1a85ff', 'charts-green': '#388a34', 'charts-yellow': '#bf8803', 'charts-orange': '#d18616', 'charts-purple': '#652d90', 'charts-red': '#e51400',
      'codeExplainer-focusBorder': '#005fb8', 'codeExplainer-staleForeground': '#bf8803', 'codeExplainer-lostForeground': '#e51400',
    },
  },
  hc: {
    bodyClass: 'vscode-high-contrast',
    vars: {
      ...shared,
      'editor-background': '#000000', 'editor-foreground': '#ffffff', foreground: '#ffffff', descriptionForeground: '#ffffff',
      'panel-border': '#6fc3df', 'editorGroup-border': '#6fc3df', focusBorder: '#f38518', contrastActiveBorder: '#f38518',
      'list-hoverBackground': 'transparent', 'list-inactiveSelectionBackground': 'transparent',
      'dropdown-background': '#000000', 'dropdown-foreground': '#ffffff', 'dropdown-border': '#6fc3df', 'input-border': '#6fc3df',
      'inputValidation-errorBackground': '#000000', 'inputValidation-errorBorder': '#6fc3df',
      'button-background': '#000000', 'button-foreground': '#ffffff', 'button-hoverBackground': '#000000',
      'button-secondaryBackground': '#000000', 'button-secondaryForeground': '#ffffff', 'button-secondaryHoverBackground': '#000000',
      'widget-shadow': '#00000000', 'textLink-foreground': '#21a6ff', 'textLink-activeForeground': '#21a6ff',
      'textCodeBlock-background': '#000000', 'textBlockQuote-background': '#000000', 'editorWidget-background': '#0c141f',
      'editorWarning-foreground': '#fff000', 'editorError-foreground': '#f48771', 'editorInfo-foreground': '#3794ff',
      'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-yellow': '#ffff00', 'charts-orange': '#d18616', 'charts-purple': '#b180d7', 'charts-red': '#f14c4c',
      'codeExplainer-focusBorder': '#f38518', 'codeExplainer-staleForeground': '#fff000', 'codeExplainer-lostForeground': '#f48771',
    },
  },
};

export function themeCss(name: ThemeName): string {
  return Object.entries(THEMES[name].vars)
    .map(([k, v]) => `--vscode-${k}: ${v};`)
    .join(' ');
}
