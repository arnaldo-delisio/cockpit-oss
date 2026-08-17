/* taste_lint — opt-in ship-check for /taste.
 * Inject into the RENDERED page via the browser javascript_tool (or paste in DevTools console).
 * Measures the live DOM and reports relational craft defects deterministically — it does NOT
 * judge aesthetics. Returns { violations: [...], summary }. Empty violations = structurally clean.
 *
 * Usage in console:  taste_lint()            // whole document
 *                    taste_lint("main")      // scope to a selector
 */
(function (root) {
  function px(v) { return Math.round(parseFloat(v) || 0); }
  function approx(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1 : tol); }
  function isFlexGrid(d) { return /^(inline-)?(flex|grid)$/.test(d); }
  function padTuple(cs) { return [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)]; }
  function padEq(a, b) { return a.every(function (v, i) { return approx(v, b[i]); }); }

  function lint(scope) {
    const rootEl = scope ? document.querySelector(scope) : document.body;
    if (!rootEl) return { violations: [{ rule: "scope", detail: "selector not found: " + scope }], summary: "scope missing" };
    const V = [];
    const sel = (el) => {
      if (el.id) return "#" + el.id;
      const cls = (el.className && el.className.toString().trim().split(/\s+/).slice(0, 2).join(".")) || "";
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    };

    // 1. Symmetric padding on card-like / padded boxes.
    rootEl.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      const pt = px(cs.paddingTop), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft), pr = px(cs.paddingRight);
      if ((pt || pb) && !approx(pt, pb)) V.push({ rule: "asymmetric-padding-y", el: sel(el), detail: `padding-top ${pt} ≠ padding-bottom ${pb}` });
      if ((pl || pr) && !approx(pl, pr)) V.push({ rule: "asymmetric-padding-x", el: sel(el), detail: `padding-left ${pl} ≠ padding-right ${pr}` });
    });

    // 2. Sibling consistency inside flex/grid containers (same padding & height across same-tag children).
    rootEl.querySelectorAll("*").forEach((parent) => {
      const cs = getComputedStyle(parent);
      if (!isFlexGrid(cs.display)) return;
      const kids = Array.from(parent.children).filter((c) => c.nodeType === 1);
      if (kids.length < 2) return;
      // group by tagName so we compare like with like
      const byTag = {};
      kids.forEach((k) => { (byTag[k.tagName] = byTag[k.tagName] || []).push(k); });
      Object.values(byTag).forEach((group) => {
        if (group.length < 2) return;
        const bPad = padTuple(getComputedStyle(group[0])), bH = Math.round(group[0].getBoundingClientRect().height);
        const row = cs.flexDirection !== "column"; // height consistency only matters in a row/grid
        group.forEach((k, i) => {
          if (i === 0) return;
          const kPad = padTuple(getComputedStyle(k));
          if (!padEq(kPad, bPad)) V.push({ rule: "sibling-padding-drift", el: sel(k), detail: `padding [${kPad}] ≠ sibling [${bPad}]` });
          if (row && !approx(Math.round(k.getBoundingClientRect().height), bH, 2)) V.push({ rule: "sibling-height-drift", el: sel(k), detail: `height ${Math.round(k.getBoundingClientRect().height)} ≠ sibling ${bH}` });
        });
      });
    });

    // 3. Off-scale gaps (flag gaps that are not on the 4px grid — a proxy for ad-hoc spacing).
    rootEl.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      if (!isFlexGrid(cs.display)) return;
      [px(cs.rowGap), px(cs.columnGap)].forEach((g) => {
        if (g && g % 4 !== 0) V.push({ rule: "off-scale-gap", el: sel(el), detail: `gap ${g}px not on 4px scale` });
      });
    });

    // dedupe
    const seen = new Set();
    const violations = V.filter((v) => { const k = v.rule + "|" + v.el + "|" + v.detail; return seen.has(k) ? false : (seen.add(k), true); });
    return { violations, summary: violations.length ? `${violations.length} craft defect(s) — fix before shipping` : "clean: no relational spacing/symmetry defects" };
  }

  root.taste_lint = lint;
  return lint(); // whole document; call window.taste_lint("selector") to scope
})(typeof window !== "undefined" ? window : globalThis);
