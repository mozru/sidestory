// Where a key sits in manifest.json, for findings' line numbers. One linear scan per manifest (it may hold
// thousands of anchors, up to 1 MB), over text `JSON.parse` already accepted: string literals are read whole, so
// text inside a value (a quote's code) is never taken for a key, and nesting is counted, so a field inside an
// anchor is never taken for a top-level one or for another anchor.
import { lineIndex } from './html.ts';

export interface ManifestLines {
  /** The line of a top-level field ("id", "trivialFiles"): its first occurrence. */
  key(name: string): number | undefined;
  /** The line of an anchor's own key in "anchors": its first occurrence. */
  anchor(id: string): number | undefined;
}

export function manifestLines(text: string): ManifestLines {
  let fields: Map<string, number> | undefined;
  let anchors: Map<string, number> | undefined;
  let line: ((offset: number) => number) | undefined;
  const scan = () => {
    fields = new Map();
    anchors = new Map();
    let depth = 0;
    /** The top-level field whose value is being read. */
    let field: string | undefined;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 123 || c === 91) depth++; // { [
      else if (c === 125 || c === 93) depth--; // } ]
      else if (c === 34) {
        // "
        let j = i + 1;
        while (j < text.length && text.charCodeAt(j) !== 34) j += text.charCodeAt(j) === 92 ? 2 : 1;
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === ':') {
          const name = text.slice(i + 1, j);
          if (depth === 1) {
            field = name;
            if (!fields.has(name)) fields.set(name, i);
          } else if (depth === 2 && field === 'anchors' && !anchors.has(name)) anchors.set(name, i);
        }
        i = j;
      }
    }
  };
  const at = (offset: number | undefined) => (offset === undefined ? undefined : (line ??= lineIndex(text))(offset));
  return {
    key(name) {
      if (!fields) scan();
      return at(fields!.get(name));
    },
    anchor(id) {
      if (!anchors) scan();
      return at(anchors!.get(id));
    },
  };
}
