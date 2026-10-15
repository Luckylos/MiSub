import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { parseIniTemplate } from '../../functions/modules/subscription/template-parsers/ini-template-parser.js';
import * as pipeline from '../../functions/modules/subscription/template-pipeline.js';
import { renderClashFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-clash.js';
import { renderSingboxFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-singbox.js';
import { renderSurgeFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-surge.js';
import { renderLoonFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-loon.js';
import { renderQuanxFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-quanx.js';
import { renderEgernFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-egern.js';
import { PINNED_RULE_REVISIONS } from '../../functions/modules/subscription/builtin-rules-provider.js';

const URL = 'https://rules.example.test/download?sets=cn,private#v1';
const options = { isMeta: true, targetFormat: 'clash' };
const template = (lines) => `[custom]\n${lines.join('\n')}`;
const declaration = (behavior, url = URL, policy = 'DIRECT') =>
  `ruleset=${policy},clash-mrs-${behavior}:${url}`;

function expectSafeMrsError(action) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error, 'MRS declarations must fail explicitly, not render unusable rules').toBeDefined();
  expect(error.name).toBe('MrsRuleProviderError');
  expect(error.message).not.toMatch(/https?:|rules\.example|fixture-secret|fixture-password/);
}

const unsupportedRenderers = [
  ['singbox', renderSingboxFromTemplateModel, pipeline.renderSingboxFromIniTemplate],
  ['surge', renderSurgeFromTemplateModel, pipeline.renderSurgeFromIniTemplate],
  ['loon', renderLoonFromTemplateModel, pipeline.renderLoonFromIniTemplate],
  ['quanx', renderQuanxFromTemplateModel, pipeline.renderQuanxFromIniTemplate],
  ['egern', renderEgernFromTemplateModel, pipeline.renderEgernFromIniTemplate],
];

describe('explicit INI MRS declarations', () => {
  it.each(['domain', 'ipcidr'])(
    'parses explicit %s metadata without splitting URL commas',
    (behavior) => {
      const model = parseIniTemplate(
        template([`  RULESET=DIRECT, CLASH-MRS-${behavior.toUpperCase()}:${URL}`]),
        options
      );
      expect(model.rules).toEqual([
        {
          type: 'rule-set',
          value: URL,
          policy: 'DIRECT',
          source: 'remote',
          extras: [],
          provider: { format: 'mrs', behavior },
        },
      ]);
    }
  );

  it('pins explicit Github sources while preserving query and fragment', () => {
    const model = parseIniTemplate(
      template([
        declaration(
          'ipcidr',
          'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.mrs?sets=a,b#release'
        ),
      ]),
      options
    );
    expect(model.rules[0].value).toBe(
      `https://cdn.jsdelivr.net/gh/SagerNet/sing-geoip@${PINNED_RULE_REVISIONS.SING_GEOIP}/geoip-cn.mrs?sets=a,b#release`
    );
  });

  it('recognizes only the final no-resolve token and preserves preceding comma data', () => {
    const model = parseIniTemplate(template([declaration('ipcidr', `${URL},no-resolve`)]), options);
    expect(model.rules[0].value).toBe(URL);
    expect(model.rules[0].extras).toEqual(['no-resolve']);
    const dataUrl = 'https://rules.example.test/download?sets=no-resolve,cn&option=unsupported';
    expect(
      parseIniTemplate(template([declaration('ipcidr', dataUrl)]), options).rules[0].value
    ).toBe(dataUrl);
  });

  it.each([
    'clash-mrs-domain:',
    'clash-mrs-domain:ftp://fixture-password@rules.example.test/file',
    'clash-mrs-domain:https://',
    'clash-mrs-classical:https://rules.example.test/file?fixture-secret',
    'clash-mrs:https://rules.example.test/file',
    'clash-mrs-domain-no-resolve:https://rules.example.test/file',
    `clash-mrs-domain:${URL},no-resolve`,
  ])('rejects invalid explicit declarations without leaking their source (%s)', (source) => {
    expectSafeMrsError(() => parseIniTemplate(template([`ruleset=DIRECT,${source}`]), options));
  });

  it.each([
    [declaration('domain'), declaration('ipcidr')],
    [declaration('domain'), `ruleset=REJECT,${URL}`],
    [`ruleset=DIRECT,clash-classic:${URL}`, declaration('domain')],
  ])('rejects conflicting URL metadata before pruning', (first, second) => {
    expectSafeMrsError(() => parseIniTemplate(template([first, second]), options));
  });

  it('renders reusable HTTP MRS providers and per-rule no-resolve in declaration order', () => {
    const config = yaml.load(
      pipeline.renderClashFromIniTemplate(
        template([
          declaration('domain', URL, 'REJECT'),
          declaration('ipcidr', 'http://rules.example.test/network?sets=cn,private', 'DIRECT'),
          declaration(
            'ipcidr',
            'http://rules.example.test/network?sets=cn,private,no-resolve',
            'REJECT'
          ),
          'ruleset=DIRECT,[]FINAL',
        ]),
        options
      )
    );
    expect(config['rule-providers']).toEqual({
      download_0: {
        type: 'http',
        behavior: 'domain',
        format: 'mrs',
        url: URL,
        path: './ruleset/download_0.mrs',
        interval: 86400,
      },
      network_1: {
        type: 'http',
        behavior: 'ipcidr',
        format: 'mrs',
        url: 'http://rules.example.test/network?sets=cn,private',
        path: './ruleset/network_1.mrs',
        interval: 86400,
      },
    });
    expect(config.rules.slice(0, 4)).toEqual([
      'RULE-SET,download_0,REJECT',
      'RULE-SET,network_1,DIRECT',
      'RULE-SET,network_1,REJECT,no-resolve',
      'MATCH,DIRECT',
    ]);
  });

  it('preserves legacy trimming around URL commas', () => {
    const model = parseIniTemplate(
      template(['ruleset= DIRECT ,clash-classic:https://rules.example.test/list?sets=a , b , c'])
    );
    expect(model.rules[0].value).toBe('https://rules.example.test/list?sets=a,b,c');
  });

  it('does not guess MRS from a legacy URL extension', () => {
    const config = yaml.load(
      pipeline.renderClashFromIniTemplate(
        template(['ruleset=DIRECT,https://rules.example.test/legacy.mrs']),
        {}
      )
    );
    expect(Object.values(config['rule-providers'])[0]).toMatchObject({
      behavior: 'classical',
      path: './ruleset/legacy_mrs_0.yaml',
    });
    expect(Object.values(config['rule-providers'])[0].format).toBeUndefined();
  });

  it('keeps legacy ACL4SSR provider mappings and resolves all rewritten rule references', () => {
    const source =
      'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list';
    const config = yaml.load(
      pipeline.renderClashFromIniTemplate(
        template([`ruleset=DIRECT,${source}`, `ruleset=REJECT,clash-classic:${source}`])
      )
    );
    expect(Object.keys(config['rule-providers'])).toEqual(['openai_0']);
    expect(config.rules.slice(0, 2)).toEqual([
      'RULE-SET,openai_0,DIRECT',
      'RULE-SET,openai_0,REJECT',
    ]);
    expect(config['rule-providers'].openai_0).toMatchObject({
      behavior: 'classical',
      path: './ruleset/openai_0.yaml',
    });
  });

  it('does not rewrite explicitly declared MRS lists to legacy YAML providers', () => {
    const source =
      'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list?sets=a,b#v1';
    const config = yaml.load(
      pipeline.renderClashFromIniTemplate(template([declaration('domain', source)]), options)
    );
    expect(Object.values(config['rule-providers'])[0]).toMatchObject({
      format: 'mrs',
      behavior: 'domain',
      url: `https://cdn.jsdelivr.net/gh/ACL4SSR/ACL4SSR@${PINNED_RULE_REVISIONS.ACL4SSR}/Clash/Ruleset/OpenAi.list?sets=a,b#v1`,
    });
    expect(config.rules[0]).toBe('RULE-SET,openai_0,DIRECT');
  });

  it('rejects ordinary Clash before an empty policy group can prune the MRS rule', () => {
    const text = `[Proxy Group]\nEmpty = select\n${template([declaration('domain', URL, 'Empty')])}`;
    expectSafeMrsError(() => pipeline.renderClashFromIniTemplate(text, { isMeta: false }));
  });

  it.each(unsupportedRenderers)(
    'rejects %s pipelines using the actual renderer target even with misleading options',
    (_target, _direct, render) => {
      const text = `[Proxy Group]\nEmpty = select\n${template([declaration('domain', URL, 'Empty')])}`;
      expectSafeMrsError(() => render(text, options));
    }
  );
});

describe('direct model MRS renderer validation', () => {
  const model = (provider = { format: 'mrs', behavior: 'ipcidr' }, extras = []) => ({
    meta: { isMeta: true, target: 'clash' },
    rules: [{ type: 'rule-set', value: URL, policy: 'DIRECT', provider, extras }],
  });

  it('renders direct model MRS metadata and no-resolve', () => {
    const config = yaml.load(renderClashFromTemplateModel(model(undefined, ['no-resolve'])));
    expect(config['rule-providers'].download_0.format).toBe('mrs');
    expect(config.rules).toEqual(['RULE-SET,download_0,DIRECT,no-resolve']);
  });

  it('rejects ordinary Clash direct rendering', () => {
    expectSafeMrsError(() => renderClashFromTemplateModel({ ...model(), meta: { isMeta: false } }));
  });

  it.each(unsupportedRenderers)(
    'rejects %s direct rendering regardless of model target',
    (_target, render) => {
      expectSafeMrsError(() => render(model()));
    }
  );

  it.each([
    [{ format: 'mrs', behavior: 'classical' }, []],
    [{ format: 'mrs', behavior: 'domain' }, ['no-resolve']],
    [{ format: 'mrs', behavior: 'ipcidr' }, ['unsupported']],
  ])('rejects invalid direct metadata/options', (provider, extras) => {
    expectSafeMrsError(() => renderClashFromTemplateModel(model(provider, extras)));
  });

  it('rejects invalid direct URLs with safe errors', () => {
    const input = model();
    input.rules[0].value = 'file:///fixture-secret';
    expectSafeMrsError(() => renderClashFromTemplateModel(input));
  });

  it('rejects conflicting explicit and legacy direct declarations', () => {
    const input = model();
    input.rules.push({ type: 'rule-set', value: URL, policy: 'REJECT' });
    expectSafeMrsError(() => renderClashFromTemplateModel(input));
  });
});
