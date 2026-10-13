import { describe, expect, it } from 'vitest';
import { SPEC_TOOL_NAMES, TOOLS } from './tools';

describe('MCP tool catalogue', () => {
  it('defines exactly the spec tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...SPEC_TOOL_NAMES].sort());
  });

  it('job-starting tools tell the client to poll get_job', () => {
    for (const t of TOOLS.filter((x) => x.startsJob)) expect(t.description).toMatch(/get_job/);
  });

  it('analyze_capture only accepts an upload id (no URLs or paths)', () => {
    const tool = TOOLS.find((t) => t.name === 'analyze_capture')!;
    expect(tool.input.safeParse({ url: 'http://example.com/a.jpg' }).success).toBe(false);
    expect(tool.input.safeParse({ upload_id: crypto.randomUUID() }).success).toBe(true);
  });
});
