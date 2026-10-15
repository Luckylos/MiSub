import { pinRemoteRuleUrl } from './builtin-rules-provider.js';

export class MrsRuleProviderError extends Error {
  constructor(reason) {
    super(`MRS rule provider: ${reason}`);
    this.name = 'MrsRuleProviderError';
  }
}

function assertHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
    return url;
  } catch {
    throw new MrsRuleProviderError('a valid HTTP(S) URL is required');
  }
}

export function parseMrsRuleSource(source) {
  if (!/^clash-mrs/i.test(source)) return null;
  const match = source.match(/^clash-mrs-(domain|ipcidr):\s*(.*)$/i);
  if (!match) throw new MrsRuleProviderError('unsupported declaration prefix or behavior');

  const behavior = match[1].toLowerCase();
  let value = match[2].trim();
  const extras = [];
  // Only this final token is reserved; other commas remain URL data.
  if (/,\s*no-resolve$/i.test(value)) {
    if (behavior !== 'ipcidr') {
      throw new MrsRuleProviderError('no-resolve is only supported for ipcidr');
    }
    value = value.replace(/,\s*no-resolve$/i, '').trim();
    extras.push('no-resolve');
  }
  const url = assertHttpUrl(value);
  const pinned = pinRemoteRuleUrl(value);
  // The legacy pinning helper drops these components when rewriting Github URLs.
  if (pinned !== value) value = `${pinned}${url.search}${url.hash}`;
  return { value, extras, provider: { format: 'mrs', behavior } };
}

export function assertMrsRuleProviders(model, target) {
  const rules = Array.isArray(model.rules) ? model.rules : [];
  const declarations = new Map();
  for (const rule of rules) {
    const isMrs = rule.provider?.format === 'mrs';
    if (isMrs) {
      if (target !== 'clash' || !model.meta?.isMeta) {
        throw new MrsRuleProviderError('explicit declarations require Mihomo/Meta Clash output');
      }
      if (
        String(rule.type || '').toLowerCase() !== 'rule-set' ||
        !['domain', 'ipcidr'].includes(rule.provider.behavior)
      ) {
        throw new MrsRuleProviderError('unsupported rule type or behavior');
      }
      assertHttpUrl(rule.value);
      const extras = rule.extras || [];
      if (
        !Array.isArray(extras) ||
        extras.some((option) => option !== 'no-resolve' || rule.provider.behavior !== 'ipcidr')
      ) {
        throw new MrsRuleProviderError('unsupported rule option');
      }
    }
    if (String(rule.type || '').toLowerCase() !== 'rule-set') continue;
    const previous = declarations.get(rule.value);
    const metadata = isMrs ? `mrs:${rule.provider.behavior}` : 'legacy';
    if (previous && previous !== metadata && (isMrs || previous.startsWith('mrs:'))) {
      throw new MrsRuleProviderError('conflicting declarations for the same source');
    }
    declarations.set(rule.value, metadata);
  }
}
