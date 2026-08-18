import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8').replace(/\r\n/g, '\n');
const booking = read('services/bookingService.ts');
const technician = read('services/technicianService.ts');
const chat = read('chat/chat.service.ts');
const scheduler = read('scheduler.ts');
const routes = read('routes/adminNotification.routes.ts');
const service = read('services/adminNotificationService.ts');

describe('admin operational notifications', () => {
  it('persists a deduplicated inbox row for every active admin', () => {
    expect(service).toContain('WHERE role::int = 1');
    expect(service).toContain('UNIQUE (admin_uid, notification_key)');
    expect(service).toContain('ON CONFLICT (admin_uid, notification_key) DO NOTHING');
  });

  it('exposes authenticated list and read endpoints', () => {
    expect(routes).toContain("router.get('/admin/notifications'");
    expect(routes).toContain("router.patch('/admin/notifications/read-all'");
    expect(routes).toContain("router.patch('/admin/notifications/:id/read'");
    expect(routes).toContain('verifyRoles([1])');
  });

  it('notifies on new booking and automatic assignment', () => {
    expect(booking).toContain("type: 'new_booking'");
    expect(technician).toContain("type: 'booking_auto_assigned'");
  });

  it('notifies on provider acceptance and decline with manual assignment guidance', () => {
    expect(technician).toContain("type: 'provider_accepted'");
    expect(technician).toContain("type: 'provider_declined'");
    expect(technician).toContain('Please assign a provider.');
  });

  it('notifies when an automatic booking chat is created and participants send messages', () => {
    expect(chat).toContain("type: 'booking_chat_created'");
    expect(chat).toContain("type: 'new_chat_message'");
    expect(chat).toContain('access.role !== "admin"');
  });

  it('schedules the active-booking summary for 07:00 Asia/Manila', () => {
    /**
     * This read the inline `cron.schedule('0 7 * * *', ...)` call. TAB 08 moved
     * the six jobs into the `SCHEDULED_JOBS` registry so scheduling is separate
     * from execution, so the schedule and timezone are asserted from the registry
     * itself rather than from the shape of the registration call.
     *
     * Asserting the exported value is stronger than asserting the source text:
     * it survives a reformat, and it fails if the entry is registered with the
     * wrong cadence rather than merely written differently.
     */
    const { SCHEDULED_JOBS } = require('../src/scheduler');
    const daily = SCHEDULED_JOBS.find(
      (j: any) => j.name === 'daily-admin-booking-summary',
    );
    expect(daily).toBeDefined();
    expect(daily.schedule).toBe('0 7 * * *');
    // Without the timezone the summary follows host UTC and lands at 15:00 Manila.
    expect(daily.options?.timezone).toBe('Asia/Manila');
    expect(scheduler).toContain("type: 'daily_active_bookings'");
  });
});
