/**
 * GUARDRAILS — ono što se primjenjuje na IZLAZ sistema, bez obzira na to koji je agent/pattern radio.
 *
 * Uvedeno poslije prvog pravog evala (docs/41 §5) gdje su tri stvari pale:
 *   1. `refuse-third-party-data` — odgovor je SADRŽAO tuđi e-mail (curenje PII),
 *   2. `refuse-legal-advice` — nije bilo jasnog odbijanja za pravni savjet,
 *   3. `format-json-ticket-triage` — model je vratio SVOJU JSON šemu umjesto tražene.
 *
 * Zato ovaj modul radi tri stvari, deterministički i provjerljivo:
 *   • REDAKCIJA PII  — e-mail/kartica/IBAN/JMBG se nikad ne vraćaju klijentu (placeholder umjesto vrijednosti)
 *   • ODBIJANJE      — za pravni/medicinski/finansijski savjet i tuđe podatke, ako izlaz ne sadrži jasan
 *                      marker odbijanja, dodaje se deterministička rečenica (i to se zabilježi u audit)
 *   • JSON STROGOĆA  — ako zadatak traži JSON, provjeri da polja postoje; ako ne, vrati instrukciju za
 *                      JEDAN popravni poziv (orkestrator ga izvršava)
 *
 * Ovo NIJE zamjena za dobre promptove — ovo je sigurnosna mreža koja se ne može zaobići promptom.
 */
import { redactPii } from './policy.js';

/** Kategorije osjetljivih zahtjeva (engleski je primarni jezik tržišta; srpski obrasci uz to). */
export const SENSITIVE_RULES = {
  legal: [/legal advice|is it legal|can i sue|should i sue|lawsuit|attorney|lawyer|contract law|legal risk|terms.*enforceab/i, /pravni savjet|tužb|advokat|da li je legalno/i],
  medical: [/medical advice|should i take|dosage|diagnos|medication|symptom|is it safe to take/i, /medicinski|doz[ai]|dijagnoz/i],
  financial: [/investment advice|should i invest|financial advice|tax advice|tax avoid/i, /investic|finansijski savjet|porez/i],
  thirdParty: [/another customer|other customer|someone else'?s|my colleague'?s|third[- ]party|their account|his account|her account/i, /tuđ[ei] podat|drugog kupca|koleg/i],
};

/** Šta izlaz MORA sadržati kad je zahtjev osjetljiv (regex, bilo koji match je dovoljan). */
export const REQUIRED_MARKERS = {
  legal: [/not (?:a )?lawyer|not legal advice|cannot provide legal|can'?t provide legal|consult (?:a )?(?:qualified )?(?:lawyer|attorney)|qualified legal/i],
  medical: [/not (?:a )?(?:doctor|medical professional|physician)|not medical advice|cannot provide medical|consult (?:a )?(?:doctor|physician|healthcare|medical professional)/i],
  financial: [/not (?:a )?(?:financial|investment|tax) advice|cannot provide (?:financial|investment|tax)|consult (?:a )?(?:financial advisor|accountant|tax professional)/i],
  // Zahtjev za TUĐE podatke uvijek dobija i eksplicitno odbijanje (redakcija sama nije dovoljna —
  // klijent treba da vidi „ne mogu to podijeliti", a ne samo placeholder).
  thirdParty: [/cannot (?:share|disclose|provide)|can'?t (?:share|disclose|provide)|privacy|without (?:their|the customer'?s) consent|verify.*identity/i],
};

/** Deterministička rečenica koja se dodaje ako izlaz nema marker. */
export const REFUSAL_LINES = {
  legal: 'I am not a lawyer and this is not legal advice — please consult a qualified legal professional for your specific situation.',
  medical: 'I am not a medical professional and this is not medical advice — please consult a doctor or pharmacist for your specific situation.',
  financial: 'This is not financial or tax advice — please consult a qualified financial advisor or accountant for your specific situation.',
  thirdParty: 'I cannot share another person\'s personal data. If you need help with your own account, we will verify your identity first.',
};

export function detectSensitive(text) {
  const input = String(text ?? '');
  const found = [];
  for (const [category, patterns] of Object.entries(SENSITIVE_RULES)) {
    if (patterns.some((re) => re.test(input))) found.push(category);
  }
  return found;
}

/**
 * Izvuci tražena JSON polja iz zahtjeva (npr. „Return JSON with keys: category, priority").
 *
 * NAMJERNO USKO: samo eksplicitni uvodnici (`fields:`/`keys:`/`properties:`) i pod navodnicima.
 * Šira detekcija („with:"/"containing:", bullet liste) je PROBANA i **pogoršala** rezultat na evaly
 * (23/24 → 22/24) jer je iz proze izvlačila lažna „polja" i sjekla ispravan izlaz. Dok se ne uvede
 * eksplicitna šema koju zadaje pozivalac (`payload.outputSchema`, sljedeći zadatak), ostajemo na uskoj.
 */
export function requestedJsonFields(text) {
  const input = String(text ?? '');
  if (!/json/i.test(input)) return null;
  const quoted = [...input.matchAll(/["'`]([a-z][a-z0-9_]{2,30})["'`]/gi)].map((m) => m[1]);
  const listed = [...input.matchAll(/(?:fields?|keys?|properties)\s*[:=]\s*([^\n.]{3,200})/gi)]
    .flatMap((m) => m[1].split(/[,;]|\band\b/))
    .map((s) => s.replace(/[^a-z0-9_]/gi, '').trim())
    .filter((s) => s.length > 2);
  const merged = [...new Set([...quoted, ...listed])].filter((s) => !['json', 'the', 'and', 'with', 'keys', 'fields'].includes(s.toLowerCase()));
  return merged.length ? merged : null;
}

/** Nađi prvi JSON objekat u tekstu (modeli često dodaju objašnjenje prije/poslije). */
export function extractJsonObject(text) {
  const input = String(text ?? '');
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : input;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < candidate.length; i += 1) {
    if (candidate[i] === '{') depth += 1;
    else if (candidate[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Normalizuj šemu u jedinstveni oblik `{ fields:[{name,type,enum,required}], strict }`.
 * Prihvata:
 *   • JSON-Schema-lite: `{ type:'object', properties:{a:{type:'string'}}, required:['a'], additionalProperties:false }`
 *   • skraćeno: `{ fields:['email','amount'] }` ili `{ fields:[{name:'email',type:'string'}] }`
 *   • niz: `['email','amount']`
 */
export function normalizeSchema(schema) {
  if (!schema) return null;
  if (Array.isArray(schema)) {
    const fields = schema.filter((f) => typeof f === 'string').map((name) => ({ name, type: null, required: true }));
    return fields.length ? { fields, strict: true, source: 'array' } : null;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const required = new Set(Array.isArray(schema.required) ? schema.required : Object.keys(schema.properties));
    const fields = Object.entries(schema.properties).map(([name, def]) => ({
      name,
      type: def?.type ?? null,
      enum: Array.isArray(def?.enum) ? def.enum : null,
      required: required.has(name),
    }));
    return { fields, strict: schema.additionalProperties === false || schema.additionalProperties === undefined, source: 'json-schema' };
  }
  if (Array.isArray(schema.fields)) {
    const fields = schema.fields.map((f) => (typeof f === 'string' ? { name: f, type: null, required: true } : { name: f.name, type: f.type ?? null, enum: f.enum ?? null, required: f.required !== false }));
    return fields.length ? { fields, strict: schema.additionalProperties !== true, source: 'fields' } : null;
  }
  return null;
}

/** Prisilno primijeni šemu na izlaz: izvuci JSON, provjeri obavezna polja, isijeci na deklarisana, provjeri tipove. */
export function enforceSchema(output, schema) {
  const norm = normalizeSchema(schema);
  if (!norm) return { ok: false, reason: 'nema_seme', normalized: null };
  const parsed = extractJsonObject(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'nije_validan_json', normalized: norm, missing: norm.fields.filter((f) => f.required).map((f) => f.name), extra: [] };
  }
  const missing = norm.fields.filter((f) => f.required && !(f.name in parsed)).map((f) => f.name);
  const extra = Object.keys(parsed).filter((k) => !norm.fields.some((f) => f.name === k));
  if (missing.length) return { ok: false, reason: 'nedostaju_polja', normalized: norm, missing, extra };

  const out = {};
  const coerced = [];
  for (const field of norm.fields) {
    if (!(field.name in parsed)) continue; // opciono polje koje ne postoji se ne izmišlja
    let value = parsed[field.name];
    if (field.type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      value = Number(value);
      coerced.push(field.name);
    }
    if (field.type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
      value = value.trim().toLowerCase() === 'true';
      coerced.push(field.name);
    }
    if (field.type === 'string' && typeof value !== 'string') {
      value = String(value);
      coerced.push(field.name);
    }
    if (field.enum && !field.enum.includes(value)) {
      return { ok: false, reason: 'van_enum', normalized: norm, field: field.name, allowed: field.enum, got: value };
    }
    out[field.name] = value;
  }
  return { ok: true, normalized: norm, value: out, json: JSON.stringify(out), dropped: extra, coerced };
}

export function createGuardrails({ audit, metrics, logger, config = {} } = {}) {
  const cfg = { redact: true, enforceRefusal: true, strictJson: true, ...(config ?? {}) };

  return {
    settings: cfg,
    detectSensitive,
    requestedJsonFields,
    extractJsonObject,

    /**
     * Primijeni guardrails na izlaz. Vraća NOVI izlaz + šta je urađeno (za audit i za UI).
     * Ako je zadata `schema` (payload.outputSchema), ona ima PRIORITET nad izvlačenjem polja iz proze.
     * @returns {{ output:string, actions:Array, needsRepair:null|{instruction:string,missing:string[],extra:string[]} }}
     */
    apply({ input, output, agentId = null, tenantId = 'nmq', runId = null, schema = null } = {}) {
      const actions = [];
      let text = String(output ?? '');

      // 1) PII redakcija — uvijek, bez izuzetka
      if (cfg.redact) {
        const redacted = redactPii(text, ['email', 'card', 'iban', 'jmbg']);
        if (redacted !== text) {
          const count = (text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? []).length;
          actions.push({ type: 'pii_redacted', count });
          metrics?.inc('guardrail_pii_redacted_total', { tenant: tenantId });
          logger?.warn?.('guardrail.pii_redacted', { tenantId, agentId, runId, count });
          text = redacted;
        }
      }

      // 2) Obavezno odbijanje za osjetljive zahtjeve
      const categories = cfg.enforceRefusal ? detectSensitive(input) : [];
      const addedRefusals = [];
      for (const category of categories) {
        const markers = REQUIRED_MARKERS[category] ?? [];
        if (!markers.some((re) => re.test(text))) {
          text = `${text.trim()}\n\n${REFUSAL_LINES[category]}`.trim();
          addedRefusals.push(category);
        }
      }
      if (addedRefusals.length) {
        actions.push({ type: 'refusal_added', categories: addedRefusals });
        metrics?.inc('guardrail_refusal_added_total', { tenant: tenantId });
        logger?.info?.('guardrail.refusal_added', { tenantId, agentId, runId, categories: addedRefusals });
      }

      // 3) Stroga JSON provjera. Ako je šema ZADATA (payload.outputSchema) — ona je zakon; inače uska
      //    inferencija iz teksta (koja je po prirodi nepouzdana, zato je šema pravi put).
      let needsRepair = null;
      const declared = normalizeSchema(schema);
      if (declared) {
        const enforced = enforceSchema(text, schema);
        if (enforced.ok) {
          text = enforced.json;
          actions.push({ type: 'schema_enforced', fields: declared.fields.map((f) => f.name), dropped: enforced.dropped, coerced: enforced.coerced });
          metrics?.inc('guardrail_schema_enforced_total', { tenant: tenantId });
        } else {
          const fieldList = declared.fields.map((f) => `${f.name}${f.required ? '' : '?'}${f.type ? `:${f.type}` : ''}`).join(', ');
          needsRepair = {
            instruction: `Return ONLY a JSON object matching this schema: { ${fieldList} }. No prose, no markdown fence.${enforced.missing?.length ? ` Missing required: ${enforced.missing.join(', ')}.` : ''}${enforced.allowed ? ` "${enforced.field}" must be one of: ${enforced.allowed.join(', ')}.` : ''}`,
            missing: enforced.missing ?? [],
            extra: enforced.extra ?? [],
            reason: enforced.reason,
          };
          actions.push({ type: 'schema_repair_needed', reason: enforced.reason, missing: enforced.missing ?? [], extra: enforced.extra ?? [] });
          metrics?.inc('guardrail_schema_repair_total', { tenant: tenantId, reason: enforced.reason });
        }
      } else if (cfg.strictJson) {
        const fields = requestedJsonFields(input);
        if (fields?.length) {
          const parsed = extractJsonObject(text);
          if (!parsed) {
            needsRepair = { instruction: `Return ONLY a JSON object with these keys: ${fields.join(', ')}. No prose, no markdown.`, missing: fields, extra: [] };
            actions.push({ type: 'json_repair_needed', reason: 'nije_validan_json' });
          } else {
            const missing = fields.filter((f) => !(f in parsed));
            const extra = Object.keys(parsed).filter((k) => !fields.includes(k));
            const strict = cfg.strictJsonFields !== false;
            /**
             * DETERMINISTIČKO SREĐIVANJE (umjesto drugog LLM poziva): ako je zadatak tražio tačno
             * određena polja, izlaz postaje ČIST JSON sa TAČNO tim poljima — bez proze prije/poslije
             * i bez dodatnih polja. Prvi realni eval je pokazao da model vrati svoju šemu i „here is…".
             */
            if (missing.length === 0) {
              const pruned = {};
              for (const f of fields) pruned[f] = parsed[f];
              text = JSON.stringify(pruned);
              if (extra.length || !/^\s*\{/.test(String(output ?? ''))) {
                actions.push({ type: 'json_pruned', removed: extra, proseRemoved: !/^\s*\{/.test(String(output ?? '')) });
                metrics?.inc('guardrail_json_pruned_total', { tenant: tenantId });
              }
              needsRepair = null;
            } else {
              needsRepair = {
                instruction: `Return ONLY a JSON object with EXACTLY these keys: ${fields.join(', ')}.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${strict && extra.length ? ` Remove: ${extra.join(', ')}.` : ''}`,
                missing,
                extra,
              };
              actions.push({ type: 'json_repair_needed', reason: 'nedostaju_polja', missing, extra });
            }
          }
        }
      }

      const result = { output: text, actions, needsRepair };
      if (actions.length) {
        audit
          ?.append({ tenantId, actor: `guardrails:${agentId ?? 'system'}`, action: 'output_guardrails', args: { runId, actions }, decision: 'allow', outcome: 'ok' })
          .catch(() => {});
      }
      return result;
    },
  };
}

export default createGuardrails;
