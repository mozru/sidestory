// The one rule for a step's title, shared by the panel (src/webview/main.ts) and the workspace index's outline
// (src/core/html-scan.ts), so the navigator, Go to Step and the sidebar never disagree
// (docs/NAVIGATION-PLAN.md §6.2): `data-explain-title`, else the first h1–h4's text, else the anchor id.
// An empty (or all-whitespace) value falls through to the next.

export function stepTitle(explainTitle: string | undefined | null, headingText: string | undefined | null, id: string): string {
  const t = explainTitle?.trim();
  if (t) return t;
  const h = headingText?.replace(/\s+/g, ' ').trim();
  if (h) return h;
  return id;
}
