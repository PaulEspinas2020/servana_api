jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

import axios from 'axios';
import { assertCleanScan, scanProviderFile } from '../src/services/providerManagedFileScanner';

const post = axios.post as jest.Mock;

describe('managed provider file scanner', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    post.mockReset();
    process.env = { ...originalEnv, NODE_ENV: 'production' };
    delete process.env.PROVIDER_DOCUMENT_SCANNER_URL;
    delete process.env.PROVIDER_DOCUMENT_SCANNER_TOKEN;
    delete process.env.ALLOW_BASELINE_DOCUMENT_SCAN;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('fails closed in production when no managed scanner is configured', async () => {
    const result = await scanProviderFile({
      buffer: Buffer.from('safe inert content'),
      mimeType: 'image/png',
      fileName: 'profile.png',
    });

    expect(result).toMatchObject({ verdict: 'unavailable', reasonCode: 'MANAGED_SCANNER_NOT_CONFIGURED' });
    expect(() => assertCleanScan(result)).toThrow('temporarily unavailable');
    expect(post).not.toHaveBeenCalled();
  });

  it('persists only the scanner CDR output when supplied', async () => {
    process.env.PROVIDER_DOCUMENT_SCANNER_URL = 'https://scanner.internal/scan';
    process.env.PROVIDER_DOCUMENT_SCANNER_TOKEN = 'scanner-token';
    post.mockResolvedValue({
      data: {
        verdict: 'clean',
        engine: 'managed/1',
        sanitizedBase64: Buffer.from('sanitized').toString('base64'),
      },
    });

    const result = await scanProviderFile({
      buffer: Buffer.from('%PDF-1.7 inert'),
      mimeType: 'application/pdf',
      fileName: 'credential.pdf',
    });

    expect(result.verdict).toBe('clean');
    expect(result.engine).toBe('managed/1');
    expect(result.sanitizedBuffer?.toString()).toBe('sanitized');
    expect(post.mock.calls[0][0]).toBe('https://scanner.internal/scan');
    expect(post.mock.calls[0][1]).toEqual(expect.objectContaining({ cdrRequested: true }));
  });
});
