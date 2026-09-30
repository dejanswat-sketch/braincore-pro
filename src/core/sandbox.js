/**
 * Sandbox: tvrde granice za alate i MCP servere.
 *
 * Nivoi:
 *   none       — bez ograničenja (samo za lokalni razvoj; u produkciji se odbija)
 *   restricted — mreža samo na allowlistu, FS samo u tenantovom folderu, env očišćen (default)
 *   strict     — kao restricted + nema spoljne mreže + samo read-only FS + kraći timeouti
 *
 * Ovo NIJE OS-level sandbox (nema seccomp/namespaces) — to radi kontejner/K8s.
 * Ovo je aplikativni sloj: sprečava najčešće zloupotrebe i daje jasnu grešku.
 */
import path from 'node:path';
import fs from 'node:fs';
import { PolicyError } from './errors.js';

export const SANDBOX_LEVELS = ['none', 'restricted', 'strict'];

export function createSandbox({
  level = 'restricted',
  networkAllowlist = [],
  fsWriteRoots = [],
  fsReadRoots = [],
  envAllowlist = [],
  maxMemoryMb = 256,
  maxTimeoutMs = 20_000,
  allowChildProcess = true,
  production = (process.env.NODE_ENV === 'production' || process.env.NMQ_ENV === 'production'),
  logger,
} = {}) {
  if (!SANDBOX_LEVELS.includes(level)) throw new PolicyError(`Nepoznat sandbox nivo: ${level}`, { level, allowed: SANDBOX_LEVELS });
  // Nivo "none" gasi sve tri zaštite — u produkciji je to tvrda greška, ne opcija
  if (level === 'none' && production) {
    throw new PolicyError('Sandbox nivo "none" nije dozvoljen u produkciji', { level, production });
  }
  const networkAllowed = level === 'strict' ? false : true;

  function assertNetwork(url) {
    if (level === 'none') return true;
    if (!networkAllowed) throw new PolicyError('Sandbox "strict": spoljna mreža je zabranjena', { url, level });
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new PolicyError(`Neispravan URL: ${url}`, { url });
    }
    if (!networkAllowlist.length) throw new PolicyError('Sandbox: network allowlist je prazan — postavi NMQ_HTTP_ALLOWLIST', { url });
    if (networkAllowlist.includes('*')) return true;
    const ok = networkAllowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!ok) throw new PolicyError(`Sandbox: domen "${host}" nije na allowlisti`, { host, allowlist: networkAllowlist });
    return true;
  }

  /**
   * Provjera putanje: read/write mora biti unutar dozvoljenog korijena i bez ".." izlaska.
   * Symlinkovi se razrješavaju (realpath) — inače bi link unutar `dataDir` mogao pokazivati van granice.
   */
  function assertPath(target, { mode = 'read' } = {}) {
    if (level === 'none') return path.resolve(target);
    const roots = mode === 'write' ? fsWriteRoots : [...fsReadRoots, ...fsWriteRoots];
    if (!roots.length) throw new PolicyError(`Sandbox: nema dozvoljenog ${mode} korijena`, { target, mode });

    const resolved = resolveReal(path.resolve(target));
    const ok = roots.some((root) => {
      const r = resolveReal(path.resolve(root));
      return resolved === r || resolved.startsWith(r + path.sep);
    });
    if (!ok) throw new PolicyError(`Sandbox: putanja "${resolved}" je izvan dozvoljenih korijena (${mode})`, { target: resolved, roots });
    if (mode === 'write' && level === 'strict') throw new PolicyError('Sandbox "strict": upis na FS je zabranjen', { target: resolved });
    return resolved;
  }

  /** realpath najbližeg postojećeg pretka (radi i kad fajl još ne postoji). */
  function resolveReal(p) {
    let current = p;
    const missing = [];
    for (let i = 0; i < 32; i += 1) {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
        return missing.length ? path.join(real, ...missing.reverse()) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return p;
        missing.push(path.basename(current));
        current = parent;
      }
    }
    return p;
  }

  /** Env za podproces: samo allowlist + NMQ_* + sistemski minimum. Nikad tajne hosta. */
  function scrubEnv(extra = {}) {
    if (level === 'none') return { ...process.env, ...extra };
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8', TZ: process.env.TZ ?? 'UTC', NODE_ENV: process.env.NODE_ENV ?? 'production' };
    for (const key of envAllowlist) if (process.env[key] !== undefined) base[key] = process.env[key];
    for (const [k, v] of Object.entries(extra)) base[k] = v;
    for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
    return base;
  }

  function assertCanSpawn(command) {
    if (!allowChildProcess) throw new PolicyError('Sandbox: pokretanje podprocesa je zabranjeno', { command });
    return true;
  }

  return {
    level,
    assertNetwork,
    assertPath,
    scrubEnv,
    assertCanSpawn,
    limits: () => ({ maxMemoryMb, maxTimeoutMs }),
    describe: () => ({
      level,
      network: networkAllowed ? (networkAllowlist.length ? `allowlist(${networkAllowlist.length})` : 'prazan allowlist') : 'zabranjena',
      fsWriteRoots,
      fsReadRoots,
      envAllowlist,
      maxMemoryMb,
      maxTimeoutMs,
      allowChildProcess,
      note: 'Aplikativni sloj. OS izolacija (namespaces/seccomp) je na kontejneru/K8s.',
    }),
    logger,
  };
}
