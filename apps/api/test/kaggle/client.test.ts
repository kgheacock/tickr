import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

beforeAll(() => {
  process.env['ROLE'] = 'worker';
  process.env['KAGGLE_USERNAME'] = 'testuser';
  process.env['KAGGLE_API_KEY'] = 'testkey123';
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('downloadDataset', () => {
  it('sends Authorization: Basic header with base64 credentials', async () => {
    const { downloadDataset } = await import('../../src/kaggle/client.js');

    const zipStream = createReadStream(join(fixtureDir, 'history.zip'));

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          const chunks: Buffer[] = [];
          zipStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          zipStream.on('end', () => {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          });
          zipStream.on('error', (err) => controller.error(err));
        },
      }),
    });

    await downloadDataset('test/dataset', mockFetch as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    const expected = Buffer.from('testuser:testkey123').toString('base64');
    expect(headers['Authorization']).toBe(`Basic ${expected}`);
    expect(url).toContain('test/dataset');
    expect(url).not.toContain('testkey123');
  });

  it('throws on non-OK response without logging credentials', async () => {
    vi.resetModules();
    const { downloadDataset } = await import('../../src/kaggle/client.js');

    const logged: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      body: null,
    });

    await expect(
      downloadDataset('test/dataset', mockFetch as typeof fetch),
    ).rejects.toThrow('Kaggle HTTP 403');

    for (const entry of logged) {
      expect(entry).not.toContain('testkey123');
    }
  });
});
