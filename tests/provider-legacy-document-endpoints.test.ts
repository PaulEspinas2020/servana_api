import fs from 'fs';
import path from 'path';

describe('legacy provider requirement endpoints', () => {
  it('retires all three mutations/reads so documents only use the private contract', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/controllers/providerController.ts'),
      'utf8',
    );
    const legacySection = source.slice(
      source.indexOf('export const uploadWorkerRequirement'),
      source.indexOf('// ─── Onboarding'),
    );

    expect(legacySection.match(/status\(410\)/g)).toHaveLength(3);
    expect(legacySection.match(/LEGACY_DOCUMENT_ENDPOINT_RETIRED/g)).toHaveLength(3);
    expect(legacySection).toContain('POST /provider/documents');
    expect(legacySection).toContain('GET /provider/documents');
    expect(legacySection).toContain('DELETE /provider/documents/:documentId');
    expect(legacySection).not.toContain('uploadFileToStorage');
    expect(legacySection).not.toContain('fileUrl');
  });
});
