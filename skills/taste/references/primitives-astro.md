# Astro / plain-HTML primitives

Same prevention model as React, no framework. Spacing is decided once (in `tokens.css`)
and consumed via CSS vars. Compose surfaces from these classes; never inline raw
`p-`/`gap-`/`m-` on a composed surface.

## Scaffold: a tiny utility layer (add to global CSS, alongside `tokens.css`)
```css
.stack        { display:flex; flex-direction:column; gap:var(--space-stack-gap); }
.stack-section{ display:flex; flex-direction:column; gap:var(--space-section-gap); }
.cluster      { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-cluster-gap); }
.grid-cards   { display:grid; gap:var(--space-card-gap);
                grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr)); }
.center       { margin-inline:auto; width:100%; max-width:var(--content-max);
                padding-inline:var(--space-page-padding); }
.card         { padding:var(--space-card-padding); border-radius:var(--radius-card);
                box-shadow:var(--shadow-card); background:#fff; }
.prose        { max-width:var(--measure); }
```

## Usage (.astro / .html)
```html
<section class="stack-section">
  <div class="center stack">
    <h2>Pricing</h2>
    <div class="grid-cards">
      <div class="card stack"> … </div>   <!-- every card: identical padding, gap, height -->
      <div class="card stack"> … </div>
    </div>
  </div>
</section>
```

## Components
- **Static** (card, badge, separator, avatar): port shadcn's Tailwind classes directly — quality lives in the classes. Drop the React.
- **Interactive / stateful** (dialog, dropdown, accordion, tabs): use **Basecoat UI** (`basecoatui.com`) — shadcn's design system as plain HTML + Tailwind + vanilla JS, theme-compatible. Or an Astro React island running genuine shadcn. Do NOT port raw shadcn markup for these — you'd lose Radix's keyboard/aria behavior.
- daisyUI / Preline are acceptable no-React alternatives, but they ship *different* spacing defaults — don't mix them with the tokens above on the same surface.
