// The content frame is sandboxed and, in VS Code, isn't served by the webview's resource loader, so
// it can't load the explainer's images, fonts or stylesheets itself; the panel can't fetch them either
// (cross-origin). The extension reads them (inside the repo, size-capped) and sends the bytes; the
// panel hands the frame blob: URLs, and inlines linked stylesheets.
import { rewriteCss } from './sanitize.ts';

const MAX_TOTAL_BYTES = 20_000_000;
const MAX_STYLESHEET_BYTES = 1_000_000;
const URL_IN_CSS = /url\("([^"]+)"\)/g; // the sanitizer writes every url() in this form

/** Fetches a file by its path relative to the explainer folder. */
export type AssetSource = (path: string) => Promise<Blob | null>;

export class Assets {
  private readonly cache = new Map<string, Promise<string | null>>();
  private bytes = 0;
  private readonly baseUrl: string;
  private readonly source: AssetSource;

  constructor(baseUrl: string, source: AssetSource) {
    this.baseUrl = baseUrl;
    this.source = source;
  }

  private path(url: string): string | null {
    try {
      return decodeURI(url.slice(this.baseUrl.length).split(/[?#]/)[0]!);
    } catch {
      return null;
    }
  }

  /** A blob: URL for a file in the explainer folder, or null if it can't or shouldn't be loaded. */
  load(url: string): Promise<string | null> {
    const path = url.startsWith(this.baseUrl) ? this.path(url) : null;
    if (!path) return Promise.resolve(null);
    let p = this.cache.get(url);
    if (!p) {
      p = this.source(path)
        .then((b) => {
          if (!b || this.bytes + b.size > MAX_TOTAL_BYTES) return null;
          this.bytes += b.size;
          return URL.createObjectURL(b);
        })
        .catch(() => null);
      this.cache.set(url, p);
    }
    return p;
  }

  /** Rewrites every local asset reference in a (not yet attached) tree. Linked stylesheets become <style>. */
  async localize(root: Element, createElement: Document['createElement']): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const link of root.querySelectorAll('link[href]')) {
      jobs.push(
        this.stylesheet(link.getAttribute('href')!).then((css) => {
          const style = createElement('style');
          style.textContent = css ?? '';
          link.replaceWith(style);
        }),
      );
    }
    await Promise.all(jobs);
    jobs.length = 0;
    for (const el of root.querySelectorAll('*')) {
      for (const attr of ['src', 'poster', 'href', 'xlink:href']) {
        const v = el.getAttribute(attr);
        if (!v?.startsWith(this.baseUrl) || (attr === 'href' && (el.localName === 'a' || el.localName === 'area'))) continue;
        jobs.push(this.load(v.split('#')[0]!).then((blob) => (blob ? el.setAttribute(attr, blob + (v.includes('#') ? v.slice(v.indexOf('#')) : '')) : el.removeAttribute(attr))));
      }
      const srcset = el.getAttribute('srcset');
      if (srcset) jobs.push(this.srcset(srcset).then((s) => (s ? el.setAttribute('srcset', s) : el.removeAttribute('srcset'))));
      const style = el.getAttribute('style');
      if (style?.includes(this.baseUrl)) jobs.push(this.css(style).then((s) => el.setAttribute('style', s)));
      if (el.localName === 'style' && el.textContent?.includes(this.baseUrl)) {
        jobs.push(
          this.css(el.textContent).then((s) => {
            el.textContent = s;
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  private async stylesheet(href: string): Promise<string | null> {
    const path = href.startsWith(this.baseUrl) ? this.path(href) : null;
    if (!path) return null;
    try {
      const blob = await this.source(path);
      if (!blob || blob.size > MAX_STYLESHEET_BYTES) return null;
      const text = await blob.text();
      return await this.css(rewriteCss(text, this.baseUrl, href));
    } catch {
      return null;
    }
  }

  private async css(text: string): Promise<string> {
    const urls = [...new Set([...text.matchAll(URL_IN_CSS)].map((m) => m[1]!).filter((u) => u.startsWith(this.baseUrl)))];
    const blobs = await Promise.all(urls.map((u) => this.load(u)));
    let out = text;
    urls.forEach((u, i) => (out = out.split(`url("${u}")`).join(blobs[i] ? `url("${blobs[i]}")` : 'none')));
    return out;
  }

  private async srcset(value: string): Promise<string | null> {
    const parts = await Promise.all(
      value.split(',').map(async (p) => {
        const [u, ...rest] = p.trim().split(/\s+/);
        const blob = u ? await this.load(u) : null;
        return blob ? [blob, ...rest].join(' ') : null;
      }),
    );
    return parts.every((p) => p !== null) ? parts.join(', ') : null;
  }
}
