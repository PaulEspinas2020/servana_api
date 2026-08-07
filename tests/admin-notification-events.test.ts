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
    expect(scheduler).toContain("cron.schedule('0 7 * * *'");
    expect(scheduler).toContain("timezone: 'Asia/Manila'");
    expect(scheduler).toContain("type: 'daily_active_bookings'");
  });
});
