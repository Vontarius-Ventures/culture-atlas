/* global document, location, history */
/*
 * Behaviour for the editable mockups (screens 14-18). Visual examples only: nothing here
 * talks to a server. Query parameters pick a state so screenshots are reproducible:
 *   ?picks=id,id    initial picks on screen 14 (ids are data-id values)
 *   ?step=1|2|3     mobile step on screen 14
 *   ?search=unavailable   Qloo search unavailable on screens 14 and 18
 *   ?state=...      screen variant (15: unavailable, 16: results)
 */
(() => {
  // One outline icon family: 20 px, 1.75 px stroke (apps/web/components/Icon.tsx).
  const ICONS = {
    plus: '<path d="M10 4v12M4 10h12"/>',
    camera:
      '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h2l1.2-1.8A1 1 0 0 1 8.5 3.8h3a1 1 0 0 1 .8.4L13.5 6h2A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/><circle cx="10" cy="10.8" r="2.8"/>',
    bookmark: '<path d="M6 3.5h8a.5.5 0 0 1 .5.5v12.5L10 13l-4.5 3.5V4a.5.5 0 0 1 .5-.5z"/>',
    arrowLeft: '<path d="M16 10H4m5-5-5 5 5 5"/>',
    arrowRight: '<path d="M4 10h12m-5-5 5 5-5 5"/>',
    chevronDown: '<path d="m5 7.5 5 5 5-5"/>',
    close: '<path d="M5 5l10 10M15 5 5 15"/>',
    check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
    search: '<circle cx="9" cy="9" r="5"/><path d="m12.8 12.8 3.7 3.7"/>',
    settings:
      '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/>',
    home: '<path d="M3.5 9 10 3.5 16.5 9v7a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5z"/>',
    image: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m3.5 14.5 4-4 3 3 2-2 4 3.5"/>',
    collection: '<rect x="4" y="6.5" width="12" height="10" rx="1.5"/><path d="M6 4h8"/>',
    calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="1.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>',
    info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.5v.01"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 1.5"/>',
  };

  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.style.display = 'none';
  sprite.innerHTML = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 20 20">${body}</symbol>`)
    .join('');
  document.body.prepend(sprite);

  const params = new URLSearchParams(location.search);
  if (params.get('state')) document.body.dataset.state = params.get('state');
  if (params.get('search') === 'unavailable') document.body.classList.add('search-unavailable');

  // ---- Screen 14: picks, counter, primary button ---------------------------------
  const MIN = 3;
  const picks = () => [...document.querySelectorAll('[data-pick]')];
  const initial = params.get('picks') ?? document.body.dataset.picks ?? null;
  if (initial !== null) {
    const ids = new Set(initial.split(',').filter(Boolean));
    for (const b of picks()) b.setAttribute('aria-pressed', String(ids.has(b.dataset.id)));
  }

  function counterText(n) {
    const left = MIN - n;
    if (left <= 0) return 'Ready';
    return left === 1 ? '1 pick to go' : `${left} picks to go`;
  }

  function update() {
    // An image that maps to several tags is one pick: count buttons, not tags.
    const ids = new Set(picks().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.id));
    const n = ids.size;
    for (const el of document.querySelectorAll('[data-counter]')) el.textContent = counterText(n);
    for (const el of document.querySelectorAll('[data-progress]')) {
      [...el.children].forEach((seg, i) => seg.classList.toggle('is-done', i < n));
    }
    const ready = n >= MIN;
    document.body.classList.toggle('is-ready', ready);
    for (const b of document.querySelectorAll('[data-primary]')) b.setAttribute('aria-disabled', String(!ready));
    for (const r of document.querySelectorAll('[data-reason]')) r.hidden = ready;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pick], [data-toggle]');
    if (t) {
      const next = t.getAttribute('aria-pressed') !== 'true';
      // Keep every copy of the same pick (e.g. a chip and a search result) in sync.
      const same = t.dataset.id ? document.querySelectorAll(`[data-id="${t.dataset.id}"]`) : [t];
      for (const s of same) s.setAttribute('aria-pressed', String(next));
      update();
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      remove.closest('li')?.remove();
      return;
    }
    const step = e.target.closest('[data-go-step]');
    if (step) {
      setStep(Number(step.dataset.goStep));
      return;
    }
    const disclosure = e.target.closest('[aria-expanded][aria-controls]');
    if (disclosure) {
      const open = disclosure.getAttribute('aria-expanded') !== 'true';
      const id = disclosure.getAttribute('aria-controls');
      for (const c of document.querySelectorAll(`[aria-expanded][aria-controls="${id}"]`))
        c.setAttribute('aria-expanded', String(open));
      const target = document.getElementById(id);
      if (target) target.hidden = !open;
    }
  });

  function setStep(n) {
    const s = Math.min(3, Math.max(1, n || 1));
    document.body.dataset.step = String(s);
    for (const el of document.querySelectorAll('[data-step-label]')) el.textContent = `Step ${s} of 3`;
    for (const el of document.querySelectorAll('[data-steps]')) {
      [...el.children].forEach((seg, i) => seg.classList.toggle('is-current', i < s));
    }
    const url = new URL(location.href);
    url.searchParams.set('step', String(s));
    history.replaceState(null, '', url);
  }

  if (document.querySelector('[data-steps]')) setStep(Number(params.get('step')) || 1);
  update();
})();
