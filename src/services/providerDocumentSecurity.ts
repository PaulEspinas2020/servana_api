import { createHash } from 'crypto';
import { AllowedUploadMime } from '../helpers/fileSignature';

export interface DocumentSecurityResult {
  safe: boolean;
  code: string;
  sha256: string;
}

/**
 * Baseline synchronous quarantine scan. This rejects the standard EICAR test
 * payload and active-content PDF constructs before storage. Production should
 * additionally route every object through the external malware scanner named
 * in DOCUMENT_UPLOAD_SECURITY_SPEC.md; this check is intentionally not called
 * an antivirus verdict.
 */
export const baselineDocumentScan = (
  buffer: Buffer,
  mime: AllowedUploadMime,
): DocumentSecurityResult => {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const sample = buffer.toString('latin1');
  if (sample.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!')) {
    return { safe: false, code: 'MALWARE_TEST_SIGNATURE', sha256 };
  }
  if (mime === 'application/pdf') {
    const unsafePdfTokens = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/OpenAction'];
    if (unsafePdfTokens.some((token) => sample.includes(token))) {
      return { safe: false, code: 'ACTIVE_PDF_CONTENT_NOT_ALLOWED', sha256 };
    }
  }
  return { safe: true, code: 'BASELINE_SCAN_PASSED', sha256 };
};
