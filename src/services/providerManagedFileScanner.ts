import axios from 'axios';
import { baselineDocumentScan } from './providerDocumentSecurity';

export type ManagedScanVerdict = 'clean' | 'infected' | 'rejected' | 'unavailable';

export interface ManagedScanResult {
  verdict: ManagedScanVerdict;
  engine: string;
  sha256: string;
  sanitizedBuffer?: Buffer;
  reasonCode?: string;
}

/**
 * Vendor-neutral managed scanning adapter.
 *
 * The configured service receives JSON containing base64 bytes and must return
 * `{ verdict: "clean"|"infected"|"rejected", engine?, sanitizedBase64? }`.
 * `sanitizedBase64` is optional CDR output and, when present, is the only data
 * persisted. Production never treats the local signature guard as antivirus.
 */
export async function scanProviderFile(input: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<ManagedScanResult> {
  const baseline = baselineDocumentScan(input.buffer, input.mimeType as any);
  if (!baseline.safe) {
    return {
      verdict: 'rejected',
      engine: 'servana-baseline',
      sha256: baseline.sha256,
      reasonCode: baseline.code,
    };
  }

  const url = String(process.env.PROVIDER_DOCUMENT_SCANNER_URL ?? '').trim();
  const token = String(process.env.PROVIDER_DOCUMENT_SCANNER_TOKEN ?? '').trim();
  if (!url || !token) {
    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_BASELINE_DOCUMENT_SCAN === 'true') {
      return { verdict: 'clean', engine: 'servana-baseline-nonproduction', sha256: baseline.sha256 };
    }
    return {
      verdict: 'unavailable',
      engine: 'not-configured',
      sha256: baseline.sha256,
      reasonCode: 'MANAGED_SCANNER_NOT_CONFIGURED',
    };
  }

  try {
    const response = await axios.post(url, {
      fileName: input.fileName,
      mimeType: input.mimeType,
      sha256: baseline.sha256,
      contentBase64: input.buffer.toString('base64'),
      cdrRequested: input.mimeType === 'application/pdf',
    }, {
      timeout: Math.max(2_000, Math.min(Number(process.env.PROVIDER_DOCUMENT_SCANNER_TIMEOUT_MS ?? 20_000), 60_000)),
      maxBodyLength: 16 * 1024 * 1024,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const verdict = String(response.data?.verdict ?? '').toLowerCase();
    if (!['clean', 'infected', 'rejected'].includes(verdict)) {
      return { verdict: 'unavailable', engine: 'invalid-response', sha256: baseline.sha256, reasonCode: 'SCANNER_INVALID_RESPONSE' };
    }
    const sanitized = response.data?.sanitizedBase64;
    return {
      verdict: verdict as ManagedScanVerdict,
      engine: String(response.data?.engine ?? 'managed-scanner').slice(0, 100),
      sha256: baseline.sha256,
      sanitizedBuffer: typeof sanitized === 'string' && sanitized.length > 0 ? Buffer.from(sanitized, 'base64') : undefined,
      reasonCode: response.data?.reasonCode ? String(response.data.reasonCode).slice(0, 100) : undefined,
    };
  } catch {
    return { verdict: 'unavailable', engine: 'managed-scanner', sha256: baseline.sha256, reasonCode: 'SCANNER_UNAVAILABLE' };
  }
}

export function assertCleanScan(result: ManagedScanResult): void {
  if (result.verdict === 'clean') return;
  const unavailable = result.verdict === 'unavailable';
  throw Object.assign(
    new Error(unavailable ? 'Document security scanning is temporarily unavailable' : 'The file did not pass security scanning'),
    {
      statusCode: unavailable ? 503 : 422,
      code: unavailable ? 'DOCUMENT_SCANNER_UNAVAILABLE' : (result.reasonCode ?? 'DOCUMENT_SECURITY_REJECTED'),
      retryable: unavailable,
    },
  );
}
