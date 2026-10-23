// Diagram parts that light up per step: `data-explain-on` (docs/AUTHORING-PLAN.md §2). The content has no script, so
// the panel sets the classes: `cx-on` on lit elements, `cx-dim` on exactly the elements that fade, `cx-dimming` on a
// diagram while anything in it is lit. Fading is computed here rather than in CSS so that a tagged element inside a
// lit group never fades inside it, nested tags don't multiply their opacity, and no `:has()` is needed.
//
// Structures are built once per render (`index`), so a step change touches only the elements whose state changes.
// The same code runs on the incoming tree before the morph (a fresh instance), so live edits never restart a fade.

/** The classes this module sets; `cleanHtml` strips them. */
export const DIAGRAM_CLASSES = ['cx-on', 'cx-dim', 'cx-dimming'] as const;

/** Above this many tagged elements in a page, nothing lights up (one log line says so). */
export const MAX_TAGGED = 5_000;

/** Never faded, nor anything inside: not drawn directly (a faded marker would fade lit wires' arrowheads), or not drawn. */
const NEVER_DIM = new Set(['defs', 'marker', 'pattern', 'clippath', 'mask', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata', 'script']);

/** Which ids are lit: the active anchor and the step that contains it. */
export interface LitIds {
  active?: string;
  step?: string;
}

interface Scope {
  el: Element;
  /** `section`: always shows its own section's state, whatever the active step. */
  section: boolean;
  /** `dim-rest`: untagged graphics fade too. */
  dimRest: boolean;
  /** For `section` mode: the nearest anchored ancestor and the step that contains it. */
  own: LitIds;
  tagged: Set<Element>;
  /** Elements on the way from the scope to a tagged element (the scope itself included). */
  spine: Set<Element>;
  /** The children worth looking at, for each element of the spine (no defs, markers, kept or nested diagrams). */
  kids: Map<Element, Element[]>;
}

export class Diagrams {
  private scopes: Scope[] = [];
  /** Tagged elements that belong to no diagram: they light up, and nothing fades around them. */
  private loose: Element[] = [];
  private ids = new Map<Element, string[]>();
  /** What this instance last set, so an update touches only what changed. */
  private on = new Set<Element>();
  private dim = new Set<Element>();
  private dimming = new Set<Element>();
  private overCap = false;

  /** Indexes the diagrams under `root`; returns the number of tagged elements found. */
  index(root: Element): number {
    this.scopes = [];
    this.loose = [];
    this.ids.clear();
    // What's marked now, whoever marked it (the incoming tree, an author's class): the first apply reconciles it.
    const marked = (cls: string) => new Set(root.querySelectorAll(`.${cls}`));
    this.on = marked('cx-on');
    this.dim = marked('cx-dim');
    this.dimming = marked('cx-dimming');
    const tagged = [...root.querySelectorAll('[data-explain-on]')];
    this.overCap = tagged.length > MAX_TAGGED;
    if (this.overCap) return tagged.length;
    const byScope = new Map<Element, Scope>();
    for (const el of tagged) {
      if (excluded(el, root)) continue;
      this.ids.set(el, (el.getAttribute('data-explain-on') ?? '').split(/\s+/).filter(Boolean));
      const scopeEl = scopeOf(el, root);
      if (!scopeEl || scopeEl === el) {
        this.loose.push(el);
        continue;
      }
      let scope = byScope.get(scopeEl);
      if (!scope) {
        const words = (scopeEl.getAttribute('data-explain-diagram') ?? '').split(/\s+/);
        const section = scopeEl.closest('[data-explain-anchor]');
        scope = {
          el: scopeEl,
          section: words.includes('section'),
          dimRest: words.includes('dim-rest'),
          own: { active: section?.getAttribute('data-explain-anchor') ?? undefined, step: section ? stepOf(section, root) : undefined },
          tagged: new Set(),
          spine: new Set([scopeEl]),
          kids: new Map(),
        };
        byScope.set(scopeEl, scope);
        this.scopes.push(scope);
      }
      scope.tagged.add(el);
      // Kept content (a legend) lights up but never fades: it isn't on the spine.
      if (kept(el, scopeEl)) continue;
      for (let p = el.parentElement; p && p !== scopeEl; p = p.parentElement) {
        if (scope.spine.has(p)) break;
        scope.spine.add(p);
      }
    }
    for (const scope of this.scopes) {
      for (const node of scope.spine) {
        scope.kids.set(node, [...node.children].filter((k) => !NEVER_DIM.has(k.localName.toLowerCase()) && !k.hasAttribute('data-explain-keep') && !(k.hasAttribute('data-explain-diagram') && k !== scope.el)));
      }
    }
    return tagged.length;
  }

  /** True when the page has more tagged elements than the panel lights up. */
  get capped(): boolean {
    return this.overCap;
  }

  /** Sets the classes for these lit ids, touching only elements whose state changes. */
  apply(lit: LitIds): void {
    const on = new Set<Element>();
    const dim = new Set<Element>();
    const dimming = new Set<Element>();
    if (!this.overCap) {
      const isOn = (el: Element, ids: LitIds) => this.ids.get(el)!.some((t) => matches(t, ids));
      for (const el of this.loose) if (isOn(el, lit)) on.add(el);
      for (const scope of this.scopes) {
        const ids = scope.section ? scope.own : lit;
        const litHere = [...scope.tagged].filter((el) => isOn(el, ids));
        for (const el of litHere) on.add(el);
        if (litHere.length === 0) continue;
        dimming.add(scope.el);
        // Elements with something lit inside them.
        const holdsOn = new Set<Element>();
        for (const el of litHere) for (let p = el.parentElement; p && p !== scope.el && !holdsOn.has(p); p = p.parentElement) holdsOn.add(p);
        const visit = (node: Element, insideTagged: boolean): void => {
          for (const kid of scope.kids.get(node) ?? []) {
            if (scope.tagged.has(kid)) {
              if (on.has(kid)) continue; // lit: everything inside stays
              if (holdsOn.has(kid)) visit(kid, true);
              else dim.add(kid);
            } else if (scope.spine.has(kid)) visit(kid, insideTagged);
            else if (scope.dimRest && !insideTagged) dim.add(kid);
          }
        };
        visit(scope.el, false);
      }
    }
    swap(this.on, on, 'cx-on');
    swap(this.dim, dim, 'cx-dim');
    swap(this.dimming, dimming, 'cx-dimming');
    this.on = on;
    this.dim = dim;
    this.dimming = dimming;
  }
}

/** Toggles a class from the elements in `before` to those in `after`, leaving the rest untouched. */
function swap(before: Set<Element>, after: Set<Element>, cls: string): void {
  for (const el of before) if (!after.has(el)) el.classList.remove(cls);
  for (const el of after) if (!before.has(el) || !el.classList.contains(cls)) el.classList.add(cls);
}

/** An id from `data-explain-on`: `anchor`, or `anchor:part` (parts arrive later; until then only part 1 is shown). */
function matches(token: string, lit: LitIds): boolean {
  const colon = token.indexOf(':');
  const id = colon < 0 ? token : token.slice(0, colon);
  if (colon >= 0 && token.slice(colon + 1) !== '1') return false;
  return id !== '' && (id === lit.active || id === lit.step);
}

/** The diagram an element belongs to: the nearest `data-explain-diagram`, else the outermost `<svg>`. */
function scopeOf(el: Element, root: Element): Element | undefined {
  const diagram = el.closest('[data-explain-diagram]');
  if (diagram && root.contains(diagram)) return diagram;
  let svg: Element | undefined;
  for (let p: Element | null = el; p && p !== root; p = p.parentElement) if (p.localName === 'svg') svg = p;
  return svg;
}

/** Inside a defs-like element: never drawn directly, so neither lit nor faded. */
function excluded(el: Element, root: Element): boolean {
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (NEVER_DIM.has(p.localName.toLowerCase())) return true;
  return false;
}

function kept(el: Element, scope: Element): boolean {
  for (let p: Element | null = el; p && p !== scope; p = p.parentElement) if (p.hasAttribute('data-explain-keep')) return true;
  return false;
}

/** The step (top-level anchored element) that holds an anchored element. */
export function stepOf(section: Element, root: Element): string | undefined {
  let step: Element | undefined;
  for (let p: Element | null = section; p && p !== root; p = p.parentElement) if (p.hasAttribute('data-explain-anchor')) step = p;
  return step?.getAttribute('data-explain-anchor') ?? undefined;
}

/** The lit ids for `active` in a tree (the live content, or the incoming tree before the morph). */
export function litIds(root: Element, active: string | undefined): LitIds {
  if (!active) return {};
  const el = root.querySelector(`[data-explain-anchor="${CSS.escape(active)}"]`);
  return { active, step: el ? stepOf(el, root) : undefined };
}
