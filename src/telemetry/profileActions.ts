/**
 * What `/` and `/profiles` do to a profile from its card, written once:
 *
 * - `activate(id, done)` switches to it. When Meridian refuses, the shared
 *   dialog (dialog.ts) says why and who keeps the profile out, from the
 *   `refusal` the route answers with, and offers what may be done: "Activate
 *   anyway" while forcing is allowed, "Release and switch" when another
 *   profile is forced, else where the forcing setting lives.
 * - `release(done)` ends a forced profile.
 * - `refreshUsage(id, done)` re-reads the profile's usage from its provider
 *   now (`POST /profiles/:id/usage/refresh`) and keeps the outcome for the
 *   card to show for a minute; `refreshing(id)` and `outcome(id)` are what a
 *   render reads, `busy()` what a poll checks before redrawing.
 *
 * `done` runs after a change so the page redraws; `refreshUsage` also runs
 * it with `false` as the read starts (redraw what you have) and with `true`
 * once it ended (fetch the new figures). The profileCardStatus.ts
 * pattern: one browser-side copy, interpolated as a string into each page.
 */
export const profileActionsJs = `
var meridianProfileActions = (function () {
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
      }, function () { return { status: 0, ok: false, data: null }; });
  }
  function refreshHeader() { if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); }

  async function activate(id, done, extra) {
    var r = await post('/profiles/active', Object.assign({ profile: id }, extra || {}));
    if (r.ok && r.data && r.data.success) {
      if (r.data.forced) meridianDialog.toast(id + ' is forced active until ' + new Date(r.data.forced.until).toLocaleTimeString(), 'ok');
      refreshHeader();
      if (done) await done();
      return true;
    }
    var refusal = r.data && r.data.refusal;
    if (!refusal) {
      await meridianDialog.fail('Could not activate ' + id, r.data,
        r.status === 0 ? 'Could not reach Meridian.' : 'Meridian refused the switch (HTTP ' + r.status + ').');
      return false;
    }
    var actions = [{ label: 'Close', value: null }];
    var link = null;
    if (refusal.forceAllowed) actions.push({ label: 'Activate anyway', value: 'force', kind: 'danger' });
    else if (refusal.kind === 'forced_elsewhere') actions.push({ label: 'Release and switch', value: 'release', kind: 'primary' });
    else if (refusal.forceable) link = { href: '/settings#routing-force', text: 'Open Settings, Routing' };
    var choice = await meridianDialog.show({
      title: 'Can\\u2019t activate ' + id,
      tone: 'warn',
      message: refusal.reason,
      facts: [['Kept out by', refusal.by]].concat(refusal.forced ? [['Forced until', new Date(refusal.forced.until).toLocaleString()]] : []),
      note: refusal.forceNote,
      link: link,
      actions: actions,
      cancelValue: null,
      focus: 0
    });
    if (choice === 'force') return activate(id, done, { force: true });
    if (choice === 'release') return activate(id, done, { releaseForce: true });
    return false;
  }

  async function release(done) {
    var r = await post('/profiles/forced/release');
    if (!r.ok) await meridianDialog.fail('Could not release the forced profile', r.data, r.status === 0 ? 'Could not reach Meridian.' : 'Meridian refused (HTTP ' + r.status + ').');
    refreshHeader();
    if (done) await done();
  }

  var inflight = Object.create(null);
  var outcomes = Object.create(null);
  var OUTCOME_MS = 60000;
  async function refreshUsage(id, done) {
    if (inflight[id]) return;
    inflight[id] = true;
    if (done) done(false);
    var r = await post('/profiles/' + encodeURIComponent(id) + '/usage/refresh');
    delete inflight[id];
    var text = r.data && typeof r.data.note === 'string' ? r.data.note
      : meridianDialog.errorText(r.data, r.status === 0 ? 'Could not reach Meridian.' : 'Meridian refused the refresh (HTTP ' + r.status + ').');
    outcomes[id] = { ok: r.ok && !!(r.data && r.data.refreshed), text: text, at: Date.now() };
    refreshHeader();
    if (done) await done(true);
  }
  function refreshing(id) { return !!inflight[id]; }
  function busy() { for (var k in inflight) return true; return false; }
  function outcome(id) {
    var o = outcomes[id];
    if (o && Date.now() - o.at > OUTCOME_MS) { delete outcomes[id]; o = null; }
    return o || null;
  }
  return { activate: activate, release: release, refreshUsage: refreshUsage, refreshing: refreshing, busy: busy, outcome: outcome };
})();
`

/** The circular-arrows icon of the refresh button, 14px like the other card icons. */
export const ICON_REFRESH_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 11-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/></svg>'

/** The refresh button's spin while its read runs; still under reduced motion. */
export const profileActionsCss = `
  .usage-refresh.spinning svg { animation: usage-refresh-spin 0.9s linear infinite; }
  @keyframes usage-refresh-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .usage-refresh.spinning svg { animation: none; } }
  .usage-refresh[disabled] { opacity: 0.6; cursor: progress; }
`
