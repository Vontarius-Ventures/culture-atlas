import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, parseDocument, type Tags } from 'yaml';
import { PUBLISHED_OPS_METRICS } from '../packages/domain/src/ops/metrics';

/**
 * Static checks of the AWS hosting shape (infra/aws). Nothing here talks to
 * AWS: the template is parsed and its security/cost invariants asserted, the
 * host scripts are syntax-checked, and atlas-env is run against a fake AWS CLI.
 */
const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const aws = (file: string) => join(repo, 'infra/aws', file);

type Json = Record<string, unknown>;
const fn = (name: string) => (value: unknown) => ({ [name]: value });
const scalar = (tag: string, name: string) => ({
  tag,
  identify: () => false,
  resolve: (value: string) =>
    name === 'GetAtt'
      ? { 'Fn::GetAtt': value.split('.') }
      : name === 'Ref'
        ? { Ref: value }
        : fn(name)(value),
});
const collection = (tag: string, name: string, kind: 'seq' | 'map') => ({
  tag,
  collection: kind,
  identify: () => false,
  resolve: (value: { toJSON(): unknown }) => fn(name)(value.toJSON()),
});
const cfnTags: Tags = [
  scalar('!Ref', 'Ref'),
  scalar('!Sub', 'Fn::Sub'),
  scalar('!GetAtt', 'GetAtt'),
  scalar('!GetAZs', 'Fn::GetAZs'),
  ...['If', 'Equals', 'Not', 'And', 'Select', 'Sub', 'Join'].map((n) =>
    collection(`!${n}`, `Fn::${n}`, 'seq'),
  ),
] as unknown as Tags;

let template: {
  Parameters: Json;
  Conditions: Json;
  Resources: Record<string, { Type: string; Properties: Json; Condition?: string }>;
  Outputs: Json;
};
let templateText: string;
const resources = (type: string) =>
  Object.entries(template.Resources).filter(([, r]) => r.Type === type);
const policies = () =>
  (template.Resources.AppRole!.Properties.Policies as unknown[]).flatMap((p) => {
    const entry = (p as Json)['Fn::If'] ? ((p as Json)['Fn::If'] as unknown[])[1] : p;
    return ((entry as Json).PolicyDocument as { Statement: Json[] }).Statement;
  });

beforeAll(async () => {
  templateText = await readFile(aws('culture-atlas.yaml'), 'utf8');
  const doc = parseDocument(templateText, { customTags: cfnTags });
  expect(doc.errors).toEqual([]);
  template = doc.toJSON();
});

describe('CloudFormation template: security', () => {
  it('keeps the media bucket private, encrypted, TLS-only and lifecycle-bounded', () => {
    const bucket = template.Resources.MediaBucket!.Properties as Json;
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(JSON.stringify(bucket.BucketEncryption)).toContain('AES256');
    const rules = (bucket.LifecycleConfiguration as { Rules: Json[] }).Rules;
    const byId = Object.fromEntries(rules.map((r) => [r.Id, r]));
    expect(byId['abort-incomplete-multipart']).toMatchObject({
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    });
    expect(byId['staging-objects']).toMatchObject({ ExpirationInDays: 2 });
    expect(byId['previous-versions-30-days']).toMatchObject({
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    });
    expect(byId['logical-backups-30-days']).toMatchObject({
      Prefix: 'backups/',
      ExpirationInDays: 30,
    });
    // Retained media is never expired by age.
    for (const rule of rules) expect(rule.Prefix ?? '').not.toMatch(/^accounts\//);
    const policy = JSON.stringify(template.Resources.MediaBucketPolicy!.Properties);
    expect(policy).toContain('aws:SecureTransport');
    expect(policy).toContain('"Effect":"Deny"');
  });

  it('grants the instance least privilege: no wildcard actions or resources, scoped S3 prefixes', () => {
    const statements = policies();
    for (const s of statements) {
      const actions = ([] as string[]).concat(s.Action as string | string[]);
      for (const action of actions) expect(action).not.toMatch(/\*$/);
      expect(s.Resource).not.toBe('*');
      expect(s.Effect).toBe('Allow');
    }
    const media = statements.find((s) => s.Sid === 'MediaObjects')!;
    expect(JSON.stringify(media.Resource)).toMatch(/accounts\/\*/);
    expect(media.Action).not.toContain('s3:PutBucketPolicy');
    const backups = statements.find((s) => s.Sid === 'WriteBackupsOnly')!;
    expect(backups.Action).toBe('s3:PutObject');
    const kms = statements.find((s) => s.Sid === 'DecryptSecureStringsViaSsmOnly')!;
    expect(JSON.stringify(kms.Condition)).toContain('kms:ViaService');
    const ssm = statements.find((s) => s.Sid === 'ReadConfiguration')!;
    expect(JSON.stringify(ssm.Resource)).toContain('parameter/culture-atlas/${EnvironmentName}');
  });

  it('exposes only HTTP(S), requires IMDSv2, encrypts disks and never bills CPU bursts', () => {
    const sg = template.Resources.AppSecurityGroup!.Properties as { SecurityGroupIngress: Json[] };
    expect(sg.SecurityGroupIngress.map((r) => r.FromPort).sort()).toEqual([443, 443, 80]);
    expect(templateText).not.toMatch(/FromPort: 22\b/);
    const lt = (template.Resources.AppLaunchTemplate!.Properties as Json)
      .LaunchTemplateData as Json;
    expect(lt.MetadataOptions).toMatchObject({
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 2,
    });
    expect(lt.CreditSpecification).toEqual({ CpuCredits: 'standard' });
    expect(JSON.stringify(lt.BlockDeviceMappings)).toContain('"Encrypted":true');
    const db = template.Resources.Database!.Properties as Json;
    expect(db).toMatchObject({
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: false,
      AllocatedStorage: '20',
    });
    expect(db.MaxAllocatedStorage).toBeUndefined();
    expect(db.MasterUserPassword).toEqual({
      'Fn::Sub': '{{resolve:ssm-secure:${DbPasswordParameter}}}',
    });
  });

  it('contains no secrets or credentials', () => {
    expect(templateText).not.toMatch(/AKIA[0-9A-Z]{16}/);
    const names = resources('AWS::SSM::Parameter').map(([, p]) =>
      JSON.stringify(p.Properties.Name),
    );
    for (const secret of ['SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'DB_PASSWORD', 'API_KEY'])
      expect(names.join(' ')).not.toContain(secret);
    expect(templateText).not.toMatch(/-----BEGIN/);
    // No SecureString is created by the template (CloudFormation cannot hold them safely).
    for (const [, p] of resources('AWS::SSM::Parameter')) expect(p.Properties.Type).toBe('String');
  });
});

describe('CloudFormation template: cost guardrails', () => {
  it('has a 1 USD monthly budget with actual and forecast email alerts', () => {
    const budget = template.Resources.MonthlyBudget!.Properties as {
      Budget: Json;
      NotificationsWithSubscribers: { Notification: Json }[];
    };
    expect(budget.Budget).toMatchObject({
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 1, Unit: 'USD' },
    });
    const kinds = budget.NotificationsWithSubscribers.map((n) => n.Notification.NotificationType);
    expect(kinds).toEqual(expect.arrayContaining(['ACTUAL', 'FORECASTED']));
  });

  it('stays within ten custom metrics and ten alarm metrics, with no NAT gateway', () => {
    const filters = resources('AWS::Logs::MetricFilter').flatMap(([, r]) =>
      (r.Properties.MetricTransformations as Json[]).map((t) => t.MetricName as string),
    );
    expect(new Set(filters).size).toBeLessThanOrEqual(10);
    for (const name of PUBLISHED_OPS_METRICS) expect(filters).toContain(name);
    const alarms = resources('AWS::CloudWatch::Alarm');
    const alarmMetrics = alarms.reduce(
      (n, [, a]) =>
        n +
        (a.Properties.Metrics
          ? (a.Properties.Metrics as Json[]).filter((m) => m.MetricStat).length
          : 1),
      0,
    );
    expect(alarmMetrics).toBeLessThanOrEqual(10);
    // Every alarm on a custom metric watches a metric that is actually published.
    for (const [, a] of alarms)
      if (a.Properties.Namespace === 'CultureAtlas')
        expect(filters).toContain(a.Properties.MetricName);
    expect(resources('AWS::EC2::NatGateway')).toHaveLength(0);
    expect(template.Parameters.InstanceType).toMatchObject({ Default: 't3.micro' });
    expect((template.Resources.LogGroup!.Properties as Json).RetentionInDays).toBe(14);
  });
});

describe('host files', () => {
  it('compose pins every image, caps memory, ships logs and publishes only Caddy ports', async () => {
    const compose = parse(await readFile(aws('compose.yml'), 'utf8'), { merge: true }) as {
      services: Record<string, Json>;
    };
    for (const [name, service] of Object.entries(compose.services)) {
      const image = String(service.image ?? '');
      expect(image, name).not.toMatch(/:latest$/);
      if (!image.startsWith('${')) expect(image, name).toMatch(/:[0-9]/);
      expect(service.mem_limit, name).toBeDefined();
      expect(JSON.stringify(service.logging ?? compose.services.web!.logging), name).toContain(
        'awslogs',
      );
      if (name !== 'caddy') expect(service.ports, name).toBeUndefined();
    }
    expect(compose.services.postgres!.profiles).toEqual(['localdb']);
    expect(compose.services.ops!.profiles).toEqual(['ops']);
  });

  it('Caddy strips headers and credential query values from access logs', async () => {
    const caddy = await readFile(aws('Caddyfile'), 'utf8');
    expect(caddy).toContain('request>headers delete');
    expect(caddy).toContain('delete X-Amz-Signature');
    expect(caddy).toContain('reverse_proxy web:3000');
  });

  it('shell scripts parse and the Dockerfile keeps runtime as the default (Render) target', async () => {
    for (const file of [
      'ship.sh',
      'bin/atlas-install',
      'bin/atlas-ops',
      'bin/atlas-backup',
      'bin/atlas-metrics',
      'bin/atlas-reload',
    ])
      await run('bash', ['-n', aws(file)]);
    for (const file of ['ship.sh', 'bin/atlas-install', 'bin/atlas-env'])
      expect((await stat(aws(file))).mode & 0o111).not.toBe(0);
    const dockerfile = await readFile(join(repo, 'Dockerfile'), 'utf8');
    const stages = [...dockerfile.matchAll(/^FROM .* AS (\w+)$/gm)].map((m) => m[1]);
    expect(stages.at(-1)).toBe('runtime');
    expect(stages).toContain('ops');
    const render = parse(await readFile(join(repo, 'render.yaml'), 'utf8')) as { services: Json[] };
    expect(render.services.map((s) => s.name)).toEqual(
      expect.arrayContaining(['culture-atlas-web', 'culture-atlas-worker']),
    );
    for (const service of render.services) expect(service.dockerfilePath).toBe('./Dockerfile');
  });
});

describe('atlas-env (SSM -> .env)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-atlas-env-'));
    await writeFile(
      join(dir, 'aws'),
      '#!/usr/bin/env bash\n[ -n "$FAKE_AWS_FAIL" ] && { echo "denied" >&2; exit 255; }\ncat "$FAKE_SSM_JSON"\n',
    );
    await chmod(join(dir, 'aws'), 0o755);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function render(
    parameters: Record<string, string>,
    mode: 'rds' | 'instance' = 'rds',
    extra: Json = {},
  ) {
    const name = `${Math.random().toString(36).slice(2)}`;
    const json = join(dir, `${name}.json`);
    const stack = join(dir, `${name}.stack`);
    const out = join(dir, `${name}.env`);
    await writeFile(
      json,
      JSON.stringify({
        Parameters: Object.entries(parameters).map(([k, v]) => ({
          Name: `/culture-atlas/prod/${k}`,
          Value: v,
        })),
      }),
    );
    await writeFile(
      stack,
      `ATLAS_PARAM_PATH=/culture-atlas/prod/\nATLAS_REGION=us-east-1\nATLAS_DB_MODE=${mode}\n`,
    );
    const result = await run('python3', [aws('bin/atlas-env')], {
      env: {
        PATH: process.env.PATH ?? '',
        AWS_BIN: join(dir, 'aws'),
        FAKE_SSM_JSON: json,
        ATLAS_STACK_ENV_FILE: stack,
        ATLAS_ENV_OUT: out,
        ...extra,
      },
    }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        code: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
      }),
    );
    const text = await readFile(out, 'utf8').catch(() => null);
    return { ...result, text, out };
  }
  const base = {
    NODE_ENV: 'production',
    SESSION_SECRET: 's3cret-session-value',
    S3_BUCKET: 'atlas-media',
    APP_BASE_URL: 'https://atlas.example.com',
    SITE_ADDRESS: 'atlas.example.com',
    DB_HOST: 'db.abc.us-east-1.rds.amazonaws.com',
    DB_SSLMODE: 'verify-full',
    DB_PASSWORD: 'p@ss:w/rd#1',
  };

  it('assembles an encoded, verify-full DATABASE_URL and writes a 0600 single-quoted env file', async () => {
    const r = await render(base);
    expect(r.code).toBe(0);
    expect(r.text).toContain(
      "DATABASE_URL='postgres://culture_atlas:p%40ss%3Aw%2Frd%231@db.abc.us-east-1.rds.amazonaws.com:5432/culture_atlas?sslmode=verify-full&sslrootcert=/etc/culture-atlas/tls/rds-ca.pem'",
    );
    expect(r.text).toContain("SESSION_SECRET='s3cret-session-value'");
    expect(r.text).not.toMatch(/^DB_PASSWORD=/m);
    expect(r.text).not.toMatch(/^POSTGRES_PASSWORD=/m);
    expect((await stat(r.out)).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain('s3cret');
  });

  it('instance mode feeds the local PostgreSQL container and disables TLS on the private network', async () => {
    const r = await render({ ...base, DB_HOST: 'postgres', DB_SSLMODE: 'disable' }, 'instance');
    expect(r.code).toBe(0);
    expect(r.text).toContain(
      "DATABASE_URL='postgres://culture_atlas:p%40ss%3Aw%2Frd%231@postgres:5432/culture_atlas'",
    );
    expect(r.text).toContain("POSTGRES_PASSWORD='p@ss:w/rd#1'");
  });

  it('fails without writing when settings are missing, unsafe or unreadable, and never prints values', async () => {
    const missing = await render({ ...base, SESSION_SECRET: '' });
    expect(missing.code).toBe(1);
    expect(missing.text).toBeNull();
    expect(missing.stderr).toContain('SESSION_SECRET');
    const quote = await render({ ...base, CONCENTRATE_API_KEY: "it's-secret" });
    expect(quote.code).toBe(1);
    expect(quote.stderr).not.toContain("it's-secret");
    const denied = await render(base, 'rds', { FAKE_AWS_FAIL: '1' });
    expect(denied.code).toBe(2);
    expect(denied.text).toBeNull();
  });
});
