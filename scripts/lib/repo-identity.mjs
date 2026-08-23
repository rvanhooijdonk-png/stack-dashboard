/**
 * REPO-IDENTITEIT — één plek die weet wáár deze repository staat.
 *
 * Aanleiding: `stack-dashboard` verhuist van een persoonlijk account naar een organisatie. Elke
 * plek die de eigenaar als letterlijke tekst droeg, brak op het moment van de overdracht — en brak
 * stil, want een Pages-adres dat niet meer bestaat levert een HTTP-fout op die de betrokken toets
 * als "plaat niet vers" leest, niet als "adres verhuisd".
 *
 * DRIE VERSCHILLENDE EIGENAARS die eerder één letterlijke tekst deelden. Ze uit elkaar houden is
 * de hele kern van deze module:
 *
 *  1. **Waar deze repository staat** (`GITHUB_REPOSITORY`). Dit verhuist mee. Alles hier gaat
 *     hierover: het Pages-adres, het raw-adres, het API-pad naar deze repo.
 *  2. **Over welk account de plaat rapporteert** (`DASHBOARD_OWNER` in `lib/collect.mjs`). Dat
 *     blijft het persoonlijke account, want `stack-control` en de bewaakte repo's verhuizen NIET
 *     mee. Wie dat hier zou binnentrekken, laat de plaat na de overdracht over een lege
 *     organisatie rapporteren — groen, en volstrekt betekenisloos.
 *  3. **Welke GitHub-gebruiker de eigenaar-goedkeuring mag geven** (`allowed_owner_actors` in
 *     `CONTROL/AUTOCODING/policy.v1.json`). Dat is een persoonslogin en verhuist per definitie
 *     nooit met een repository mee.
 *
 * De identiteit wordt AFGELEID, niet geconfigureerd, en alleen uit bronnen die het HEDEN kennen:
 * `GITHUB_REPOSITORY`, dat de runtime bij elke draai zelf zet, of `DASHBOARD_REPOSITORY`, dat een
 * mens uitdrukkelijk meegeeft. Er is bewust geen letterlijke terugvaloptie — een verkeerde gok is
 * hier erger dan een luide fout.
 *
 * WAAROM DE `origin`-REMOTE GEEN BRON IS. Het lag voor de hand om lokaal de remote van de werkboom
 * te lezen, maar die weet niets van het heden: hij bewaart wat er bij het klonen is opgeschreven.
 * GitHub verplaatst een repository server-side en blijft de oude naam daarna doorverwijzen, dus na
 * de overdracht blijven `fetch` en `push` van een bestaande kloon gewoon werken terwijl `origin`
 * nog letterlijk de vorige eigenaar noemt. Die stand is syntactisch onberispelijk en juist daarom
 * gevaarlijk: hij zou hier het Pages- en raw-adres van een verdwenen host opleveren, en dat is
 * precies de stille storing die deze module moet uitsluiten. De remote wordt dus nog wél gelezen,
 * maar uitsluitend om de foutmelding te kunnen laten zien wat er gevonden is.
 */

import { execFileSync } from 'node:child_process';

/** GitHub-namen zijn alfanumeriek met `-._`. Alles daarbuiten is geen naam maar een poging. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/repo` uit een tekst, of `null`. Werpt niet: de aanroeper beslist wat een misser betekent. */
export function parseRepository(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo };
}

/**
 * `owner/repo` uit een git-remote. Beide vormen die deze werkboom in de praktijk draagt:
 * `git@github.com:owner/repo.git` en `https://github.com/owner/repo(.git)`.
 */
export function repositoryFromRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/^(?:git@github\.com:|(?:ssh:\/\/git@|https?:\/\/)(?:[^@/]+@)?github\.com\/)(.+?)(?:\.git)?\/?$/);
  return m ? parseRepository(m[1]) : null;
}

/**
 * De Pages-HOST is de eigenaar in KLEINE LETTERS — GitHub maakt daar geen uitzondering op, ook
 * niet voor een organisatie die met hoofdletters is aangemaakt. Bij het persoonlijke account waar
 * deze repository vandaan komt was dat verschil onzichtbaar, want die naam was al klein; bij de
 * organisatie is het precies het verschil tussen een werkend en een verzonnen adres. Het PAD houdt
 * de schrijfwijze van de repositorynaam.
 */
export function pagesOrigin(owner) {
  if (!NAME.test(owner ?? '')) throw new Error('ongeldige eigenaar voor een Pages-adres');
  return `https://${owner.toLowerCase()}.github.io`;
}

/** Het Pages-adres van deze repository, met afsluitende slash bij de wortel. */
export function pagesUrl({ owner, repo }, path = '') {
  if (!NAME.test(repo ?? '')) throw new Error('ongeldige repositorynaam voor een Pages-adres');
  const rest = String(path).replace(/^\/+/, '');
  return `${pagesOrigin(owner)}/${repo}/${rest}`;
}

/** Het raw-adres van één bestand op één ref. Hoofdletters blijven staan: dit is geen hostnaam. */
export function rawUrl({ owner, repo }, ref, path) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new Error('ongeldige repository voor een raw-adres');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${String(path).replace(/^\/+/, '')}`;
}

/** `owner/repo` als tekst — de vorm die `gh` en de REST-API willen. */
export function repositorySlug({ owner, repo }) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new Error('ongeldige repository');
  return `${owner}/${repo}`;
}

/** Het voorvoegsel waaronder github.com-URL's van één eigenaar vallen. */
export function ownerUrlPrefix(owner) {
  if (!NAME.test(owner ?? '')) throw new Error('ongeldige eigenaar');
  return `https://github.com/${owner}/`;
}

/** De expliciete override: bedoeld voor een proefdraai tegen een fork of na een overdracht. */
export const OVERRIDE_ENV = 'DASHBOARD_REPOSITORY';

/**
 * De identiteit uit de meegegeven omgeving, zonder enige buitenwereld aan te raken. Volgorde: de
 * expliciete override wint, daarna de Actions-context.
 *
 * AFWEZIG en ONGELDIG zijn hier twee verschillende dingen. Een override die er niet is, laat het
 * gewone pad gewoon doorlopen. Een override die er wél is maar geen `owner/repo` vormt, is een
 * tikfout in een uitdrukkelijke aanwijzing; stilletjes terugvallen op het gewone repository zou de
 * proefdraai laten slagen tegen het verkeerde object, en dat leest achteraf als een geldige meting.
 * Daarom werpt dat geval.
 *
 * Leeg of alleen spaties telt als AFWEZIG. Dat is geen slordigheid maar de vorm waarin Actions een
 * niet-ingevulde `env:`-waarde doorgeeft; daar een harde fout van maken zou elke workflow breken
 * die de override netjes optioneel doorgeeft.
 */
export function resolveIdentity(env = {}) {
  const ruw = env[OVERRIDE_ENV];
  if (typeof ruw === 'string' && ruw.trim() !== '') {
    const expliciet = parseRepository(ruw);
    if (!expliciet) {
      throw new Error(
        `${OVERRIDE_ENV} is gezet op ${JSON.stringify(ruw)}, en dat is geen \`owner/repo\`. Een `
        + 'override is een uitdrukkelijke aanwijzing: terugvallen op het gewone repository zou hier '
        + 'stilzwijgend het verkeerde object meten.',
      );
    }
    return expliciet;
  }
  return parseRepository(env.GITHUB_REPOSITORY);
}

/** De `origin`-remote van een werkboom, of `null` als er geen git of geen remote is. */
export function originRemoteUrl(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * De identiteit van de repository waarin dit draait. Fail-closed: kan hij niet worden vastgesteld,
 * dan werpt dit. Een stilzwijgende terugval op de vorige eigenaar is precies het defect dat deze
 * module opheft — dan zou de overdracht groen doorlopen en naar het oude, verdwenen adres kijken.
 *
 * De `origin`-remote wordt hier alleen nog gelezen om de fout bruikbaar te maken. Wie lokaal draait
 * krijgt zo te zien wat er in de werkboom staat, waarom dat geen bewijs van de huidige plaats is,
 * en met welke ene omgevingsvariabele hij het zelf kan zeggen.
 */
export function detectIdentity(env = process.env, { cwd = process.cwd() } = {}) {
  const actueel = resolveIdentity(env);
  if (actueel) return actueel;
  const gekloond = repositoryFromRemoteUrl(originRemoteUrl(cwd));
  throw new Error(gekloond
    ? `de origin van deze werkboom wijst naar ${gekloond.owner}/${gekloond.repo}, maar dat is `
      + 'git-configuratie uit het moment van klonen: een overdracht laat hem ongewijzigd en GitHub '
      + `blijft de oude naam doorverwijzen. Zet ${OVERRIDE_ENV}=owner/repo als je zeker weet waar `
      + 'deze repository nu staat, of draai dit in een context die GITHUB_REPOSITORY zet.'
    : 'kan de eigenaar van deze repository niet vaststellen: geen DASHBOARD_REPOSITORY, geen '
      + 'GITHUB_REPOSITORY en geen leesbare origin-remote');
}
