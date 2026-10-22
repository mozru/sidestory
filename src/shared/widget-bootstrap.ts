// The only script a widget frame's own HTML contains. The panel's CSP allows it by hash (computed by the
// extension from this exact text) together with 'strict-dynamic', so the scripts it appends (the runtime,
// libraries and widget code, delivered by message) run without the panel's nonce ever reaching them.
// See docs/WIDGETS-PLAN.md §3 and §5.4. Plain ES2020, no imports: it is inlined verbatim.
export const WIDGET_BOOTSTRAP = `(() => {
  'use strict';
  // Only in a sandboxed (opaque-origin) frame; never in the panel or a same-origin frame.
  if (self.origin !== 'null' || self === self.parent) return;
  // Best-effort hardening before anything else runs (the boundary is consent; see SECURITY.md).
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCRtpSender', 'RTCRtpReceiver',
    'RTCRtpTransceiver', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport']) {
    try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) { /* not present */ }
  }
  const NET = /(^|\\s)(prefetch|preconnect|dns-prefetch|prerender|modulepreload|preload)(\\s|$)/i;
  const relDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'rel');
  Object.defineProperty(HTMLLinkElement.prototype, 'rel', { configurable: false, get: relDesc.get,
    set(v) { relDesc.set.call(this, NET.test(String(v)) ? '' : v); } });
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (this instanceof HTMLLinkElement && String(n).toLowerCase() === 'rel' && NET.test(String(v))) return;
    return setAttr.call(this, n, v);
  };
  new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) {
    if (n instanceof Element) for (const l of [n, ...n.querySelectorAll('link')]) if (l instanceof HTMLLinkElement && NET.test(l.rel)) l.remove();
  } }).observe(document, { subtree: true, childList: true });
  // Trusted Types is inherited from the panel; this realm gets its own pass-through default policy.
  self.trustedTypes.createPolicy('default', { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });
  let loaded = false;
  self.addEventListener('message', (e) => {
    if (loaded || e.source !== self.parent || !e.data || e.data.type !== 'load' || !Array.isArray(e.data.scripts)) return;
    loaded = true;
    for (const text of e.data.scripts) {
      const s = document.createElement('script');
      s.textContent = String(text);
      document.head.append(s);
    }
  });
  self.parent.postMessage({ type: 'boot' }, '*');
})();`;
