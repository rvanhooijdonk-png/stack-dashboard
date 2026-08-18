/**
 * Tests voor render-tickers.mjs. Twee dingen zijn hier niet decoratief maar bewezen bugs uit deze
 * bouwsessie: (1) de zelf-refresh moet naar de EIGEN pagina wijzen, niet naar de cockpit (`./`),
 * en (2) de cache-buster moet uit `generatedAt` komen, nooit uit het weergave-stempel (dat gaf
 * altijd NaN → '0'). Beide krijgen een expliciete regressietest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTransactieTicker, renderCodeTicker } from '../scripts/lib/render-tickers.mjs';

test('transactie-ticker zonder feed: fail-closed pagina, refresh wijst naar zichzelf met v=0', () => {
  const html = renderTransactieTicker({ available: false });
  assert.match(html, /Geen feed beschikbaar/);
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/transacties\.html\?v=0">/);
  assert.doesNotMatch(html, /url=\.\/\?v=/);
});

test('code-ticker zonder feed: fail-closed pagina, refresh wijst naar zichzelf met v=0', () => {
  const html = renderCodeTicker({ available: false });
  assert.match(html, /Geen feed beschikbaar/);
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/code-ticker\.html\?v=0">/);
  assert.doesNotMatch(html, /url=\.\/\?v=/);
});

test('transactie-ticker: cache-buster bestaat uitsluitend uit de cijfers van generatedAt, nooit uit het stempel', () => {
  const feed = { available: true, freshness: 'CURRENT', generatedAt: '2026-08-18T11:59:30Z', events: [] };
  const html = renderTransactieTicker(feed);
  assert.match(html, /url=\.\/transacties\.html\?v=20260818115930/);
});

test('code-ticker: cache-buster bestaat uitsluitend uit de cijfers van generatedAt', () => {
  const feed = { available: true, freshness: 'CURRENT', generatedAt: '2026-08-18T11:59:30Z', entries: [] };
  const html = renderCodeTicker(feed);
  assert.match(html, /url=\.\/code-ticker\.html\?v=20260818115930/);
});

test('transactie-ticker: events sorteren nieuwste boven en tonen NL-labels + HTML-escaped detail', () => {
  const feed = {
    available: true,
    freshness: 'CURRENT',
    generatedAt: '2026-08-18T12:00:00Z',
    events: [
      { at: '2026-08-18T11:00:00Z', source: 'dispatcher', kind: 'DISPATCHER_RUN', detail: 'oudste' },
      { at: '2026-08-18T11:30:00Z', source: 'git', kind: 'GIT_PR_MERGED', detail: '<script>alert(1)</script>' },
    ],
  };
  const html = renderTransactieTicker(feed);
  const iOud = html.indexOf('oudste');
  const iNieuw = html.indexOf('PR gemerged');
  assert.ok(iNieuw > -1 && iOud > -1 && iNieuw < iOud, 'nieuwste event moet vóór het oudste in de HTML staan');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('transactie-ticker: klokbadge volgt freshness (CURRENT/STALE/UNKNOWN)', () => {
  const basis = { available: true, generatedAt: '2026-08-18T12:00:00Z', events: [] };
  assert.match(renderTransactieTicker({ ...basis, freshness: 'CURRENT' }), /badge ok">klok actueel/);
  assert.match(renderTransactieTicker({ ...basis, freshness: 'STALE' }), /badge bad">klok verouderd/);
  assert.match(renderTransactieTicker({ ...basis, freshness: 'UNKNOWN' }), /badge warn">klok onbekend/);
});

test('transactie-ticker: onbekende source/kind vallen terug op de rauwe waarde in plaats van te crashen', () => {
  const feed = {
    available: true,
    freshness: 'CURRENT',
    generatedAt: '2026-08-18T12:00:00Z',
    events: [{ at: '2026-08-18T11:59:00Z', source: 'verzonnen-bron', kind: 'VERZONNEN_KIND', detail: 'x' }],
  };
  const html = renderTransactieTicker(feed);
  assert.match(html, /verzonnen-bron/);
  assert.match(html, /VERZONNEN_KIND/);
});

test('code-ticker: toont lane, NL-actielabel en resultaatlabel, met rc= en orderId als aanwezig', () => {
  const feed = {
    available: true,
    freshness: 'CURRENT',
    generatedAt: '2026-08-18T12:00:00Z',
    entries: [
      { at: '2026-08-18T11:59:00Z', lane: 'codex1', action: 'DISPATCH_END', result: 'FAIL', exitCode: 1, orderId: 'DB-1' },
      { at: '2026-08-18T11:58:00Z', lane: 'claude2', action: 'HEALTH_CHECK', result: 'OK' },
    ],
  };
  const html = renderCodeTicker(feed);
  assert.match(html, /codex1/);
  assert.match(html, /dispatch einde/);
  assert.match(html, /detail bad">FAIL/);
  assert.match(html, /rc=1/);
  assert.match(html, /DB-1/);
  assert.match(html, /health-check/);
  assert.match(html, /detail ok">OK/);
});

test('code-ticker: exitCode 0 wordt getoond (geen "0 is falsy dus weggelaten"-bug)', () => {
  const feed = {
    available: true,
    freshness: 'CURRENT',
    generatedAt: '2026-08-18T12:00:00Z',
    entries: [{ at: '2026-08-18T11:59:00Z', lane: 'claude1', action: 'DISPATCH_END', result: 'OK', exitCode: 0 }],
  };
  const html = renderCodeTicker(feed);
  assert.match(html, /rc=0/);
});

test('code-ticker: vermeldt expliciet dat de pagina structuur-only is (geen ruwe output)', () => {
  const feed = { available: true, freshness: 'CURRENT', generatedAt: '2026-08-18T12:00:00Z', entries: [] };
  assert.match(renderCodeTicker(feed), /Structuur-only: lane, actie en resultaat/);
});

test('beide pagina’s zonder events/entries tonen de lege-staat, geen kapotte lijst', () => {
  const t = renderTransactieTicker({ available: true, freshness: 'CURRENT', generatedAt: '2026-08-18T12:00:00Z', events: [] });
  const c = renderCodeTicker({ available: true, freshness: 'CURRENT', generatedAt: '2026-08-18T12:00:00Z', entries: [] });
  assert.match(t, /Geen events in deze publicatie\./);
  assert.match(c, /Geen regels in deze publicatie\./);
});
