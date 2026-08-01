/**
 * `GET /api/workers/:uid` must not hand a provider's life to whoever asks.
 *
 * The endpoint had no auth and no projection. One response shape served three
 * audiences, so anyone holding a provider uid received their email, birthdate,
 * gender, home addresses, compliance documents, complete booking history —
 * naming every customer they had ever served — plus their disbursement ledger
 * and earnings summary.
 *
 * The customer app calls it to put a name and a phone number on the booking
 * detail screen. That is what a customer gets now.
 */

import {
  projectProviderProfile,
  WITHHELD_FROM_OTHERS,
} from '../src/services/providerProfileProjection';

/** Shape the controller assembles before projecting. */
const FULL = {
  uid: 'provider-1',
  firstName: 'Ana',
  lastName: 'Cruz',
  phoneNumber: '+639171234567',
  photoUrl: 'https://cdn/x.jpg',
  roleName: 'Technician',
  email: 'ana@example.com',
  birthdate: '1990-04-02',
  gender: 'F',
  isEmailVerified: true,
  isArchive: false,
  createdDate: '2024-01-01',
  addresses: [{ addressId: 'a1', addressOne: '12 Private St', postTown: 'Taguig' }],
  requirements: [{ id: 1, fileUrl: 'https://cdn/id-card.pdf', fileName: 'nbi.pdf' }],
  services: [{ id: 3, name: 'Aircon cleaning', category: 'Aircon', assignedAt: '2024-05-01' }],
  bookingHistory: [{ bookingId: 91, customer_name: 'Other Customer', address: '9 Elm Rd' }],
  disbursementHistory: [{ id: 7, amount: 4200, status: 'PAID' }],
  earningsSummary: { lifetime: 128400, pending: 3200 },
};

describe('a customer asking who is coming to their house', () => {
  const seen = projectProviderProfile(FULL, 'other')!;

  it('gets what the booking screen actually renders', () => {
    // These are the fields booking_detail_screen.dart and
    // assignment_polling_service.dart read. Dropping any of them would be a
    // functional regression in the live app.
    expect(seen.firstName).toBe('Ana');
    expect(seen.lastName).toBe('Cruz');
    expect(seen.phoneNumber).toBe('+639171234567');
    expect(seen.photoUrl).toBe('https://cdn/x.jpg');
  });

  it.each(WITHHELD_FROM_OTHERS)('does not receive %s', (field) => {
    expect(seen).not.toHaveProperty(field);
  });

  it('receives no customer name from the provider booking history', () => {
    const blob = JSON.stringify(seen);
    expect(blob).not.toContain('Other Customer');
    expect(blob).not.toContain('9 Elm Rd');
  });

  it('receives no financial figures', () => {
    const blob = JSON.stringify(seen);
    expect(blob).not.toContain('128400');
    expect(blob).not.toContain('4200');
  });

  it('receives no compliance document urls', () => {
    expect(JSON.stringify(seen)).not.toContain('id-card.pdf');
  });

  it('sees service names but not roster timestamps', () => {
    expect(seen.services).toEqual([
      { id: 3, name: 'Aircon cleaning', category: 'Aircon' },
    ]);
  });

  it('withholds a newly added field by default', () => {
    // The allow-list is explicit precisely so a column added to the underlying
    // query cannot silently widen what a customer receives.
    const withNewColumn = { ...FULL, nationalIdNumber: 'X-999' };
    const out = projectProviderProfile(withNewColumn, 'other')!;
    expect(out).not.toHaveProperty('nationalIdNumber');
  });
});

describe('the provider and admins still see everything', () => {
  it('self is unprojected', () => {
    expect(projectProviderProfile(FULL, 'self')).toBe(FULL);
  });

  it('admin is unprojected', () => {
    expect(projectProviderProfile(FULL, 'admin')).toBe(FULL);
  });
});

describe('edge cases', () => {
  it('null stays null', () => {
    expect(projectProviderProfile(null, 'other')).toBeNull();
  });

  it('omits absent optional fields rather than emitting nulls', () => {
    const sparse = projectProviderProfile(
      { uid: 'p', firstName: 'Ana', phoneNumber: null }, 'other')!;
    expect(sparse).toEqual({ uid: 'p', firstName: 'Ana' });
  });
});

describe('the route is authenticated', () => {
  it('GET /workers/:uid carries verifyAuth', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'technician.routes.ts'), 'utf8');
    const line = src.split('\n')
      .find((l: string) => /^router\.get\("\/workers\/:uid"/.test(l.trim()));
    expect(line).toBeDefined();
    expect(line).toContain('verifyAuth');
  });
});
