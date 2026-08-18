jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/helpers/firebaseStorageUploader', () => ({
  __esModule: true,
  uploadFileToStorage: jest.fn(),
  deletePrivateStoredFile: jest.fn(),
}));

import dbQuery from '../src/db/dbQuery';
import { uploadFileToStorage, deletePrivateStoredFile } from '../src/helpers/firebaseStorageUploader';
import { setSpecificServiceBanner, removeSpecificServiceBanner } from '../src/services/providerCatalogService';

const query  = dbQuery.query as jest.Mock;
const upload = uploadFileToStorage as jest.Mock;
const del    = deletePrivateStoredFile as jest.Mock;

// Real magic bytes — the validator sniffs these, so a fixture of zeroes would be
// rejected for the wrong reason and prove nothing.
// Padded past the 8-byte PNG signature on purpose: the sniffer requires more than
// the header alone, and a bare 8-byte fixture would fail for the wrong reason.
const png  = (extra = 16) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const uri  = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

/** SELECT (existing row) → UPDATE → then getAdminSpecificService's two reads. */
const mockHappyPath = (existingBanner: string | null = null) => {
  query.mockReset();
  query
    .mockResolvedValueOnce({ rows: [{ id: 7, level_3: 'Deep Clean', banner_url: existingBanner }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // UPDATE
    .mockResolvedValueOnce({ rows: [{ id: 7, banner_url: 'x' }], rowCount: 1 }) // getAdminSpecificService
    .mockResolvedValueOnce({ rows: [] });                                    // addons
};

describe('specific service banner — upload validation', () => {
  beforeEach(() => { query.mockReset(); upload.mockReset(); del.mockReset(); });

  it('rejects a file whose contents do not match the declared image type', async () => {
    // The whole point of sniffing: a caller can claim any Content-Type it likes.
    query.mockResolvedValueOnce({ rows: [{ id: 7, level_3: 'x', banner_url: null }], rowCount: 1 });
    await expect(setSpecificServiceBanner(7, uri('image/png', jpeg()), 'a.png', 'admin'))
      .rejects.toThrow(/contents do not match/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a disallowed mime type outright', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7, level_3: 'x', banner_url: null }], rowCount: 1 });
    await expect(setSpecificServiceBanner(7, uri('application/pdf', png()), 'a.pdf', 'admin'))
      .rejects.toThrow(/JPG, PNG or WebP/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects anything that is not a base64 data URI', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7, level_3: 'x', banner_url: null }], rowCount: 1 });
    await expect(setSpecificServiceBanner(7, 'https://example.com/a.png', 'a.png', 'admin'))
      .rejects.toThrow(/base64 data URI/i);
  });

  it('measures the DECODED size, not the base64 length', async () => {
    // base64 inflates by ~4/3, so a naive length check rejects ~3.75 MB images.
    query.mockResolvedValueOnce({ rows: [{ id: 7, level_3: 'x', banner_url: null }], rowCount: 1 });
    const overFiveMb = png(5 * 1024 * 1024 + 1024);
    await expect(setSpecificServiceBanner(7, uri('image/png', overFiveMb), 'big.png', 'admin'))
      .rejects.toThrow(/5 MB or smaller/i);
  });

  it('accepts an image just under the limit', async () => {
    mockHappyPath();
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fx.png?alt=media&token=t');
    await expect(setSpecificServiceBanner(7, uri('image/png', png(4 * 1024 * 1024)), 'ok.png', 'admin'))
      .resolves.toBeDefined();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('404s for a service option that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(setSpecificServiceBanner(999, uri('image/png', png()), 'a.png', 'admin'))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('specific service banner — storage naming and cleanup', () => {
  beforeEach(() => { query.mockReset(); upload.mockReset(); del.mockReset(); });

  it('does not double the file extension', async () => {
    // uploadFileToStorage appends its own extension from the mime type, so passing
    // "photo.png" through produced "…photo.png.png".
    mockHappyPath();
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media&token=t');
    await setSpecificServiceBanner(7, uri('image/png', png()), 'photo.png', 'admin');
    const [folder, name] = upload.mock.calls[0];
    expect(folder).toBe('service-banners/7');
    expect(name).not.toMatch(/\.png$/);
    expect(name).toMatch(/photo/);
  });

  it('sanitises a hostile filename', async () => {
    mockHappyPath();
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media&token=t');
    await setSpecificServiceBanner(7, uri('image/png', png()), '../../etc/passwd.png', 'admin');
    const name = upload.mock.calls[0][1] as string;
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('withdraws the image it replaced', async () => {
    // Clearing the column is not enough: these URLs carry an embedded download
    // token, so an orphaned object stays publicly fetchable forever.
    const previous = 'https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fold.png?alt=media&token=t';
    mockHappyPath(previous);
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fnew.png?alt=media&token=t2');
    await setSpecificServiceBanner(7, uri('image/png', png()), 'new.png', 'admin');
    expect(del).toHaveBeenCalledWith('service-banners/7/old.png');
  });

  it('never deletes an object outside the banner folder', async () => {
    const foreign = 'https://firebasestorage.googleapis.com/v0/b/b/o/provider-requirements%2Fsecret.png?alt=media&token=t';
    mockHappyPath(foreign);
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fnew.png?alt=media&token=t2');
    await setSpecificServiceBanner(7, uri('image/png', png()), 'new.png', 'admin');
    expect(del).not.toHaveBeenCalled();
  });

  it('a failed cleanup does not fail the admin edit', async () => {
    const previous = 'https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fold.png?alt=media&token=t';
    mockHappyPath(previous);
    upload.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fnew.png?alt=media&token=t2');
    del.mockRejectedValue(new Error('storage down'));
    await expect(setSpecificServiceBanner(7, uri('image/png', png()), 'new.png', 'admin'))
      .resolves.toBeDefined();
  });
});

describe('specific service banner — removal', () => {
  beforeEach(() => { query.mockReset(); upload.mockReset(); del.mockReset(); });

  it('reads the old URL before clearing it, then withdraws the object', async () => {
    // RETURNING on the UPDATE yields the NEW row, where banner_url is already NULL —
    // so the old value has to be read first or there is nothing left to delete.
    const previous = 'https://firebasestorage.googleapis.com/v0/b/b/o/service-banners%2F7%2Fold.png?alt=media&token=t';
    query
      .mockResolvedValueOnce({ rows: [{ banner_url: previous }], rowCount: 1 })  // SELECT
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })                 // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })                 // read back
      .mockResolvedValueOnce({ rows: [] });
    await removeSpecificServiceBanner(7, 'admin');
    expect(del).toHaveBeenCalledWith('service-banners/7/old.png');
  });

  it('404s when the service option does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(removeSpecificServiceBanner(999, 'admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});
