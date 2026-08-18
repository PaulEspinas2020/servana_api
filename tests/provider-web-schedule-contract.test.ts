import fs from 'fs';
import path from 'path';

describe('provider web schedule boundary', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '../src/controllers/providerController.ts'),
    'utf8',
  );
  const save = controller.slice(
    controller.indexOf('export const saveWorkerAvailability'),
    controller.indexOf('export const getWorkerTimeOff'),
  );

  it('requires the seven canonical weekdays exactly once before persistence', () => {
    expect(save).toContain('schedule.length === WEB_ALL_DAYS.length');
    expect(save).toContain('new Set(submittedDays).size === WEB_ALL_DAYS.length');
    expect(save).toContain('WEB_ALL_DAYS.every(day => submittedDays.includes(day))');
    // Matches the CALL, not its argument list. This asserted
    // `bridgeToEngineSlots(schedule)` and broke when TAB 06 added a second
    // argument to carry mobile capacity forward — the ordering it exists to
    // check was never in question. A source-text assertion should pin the
    // narrowest thing that expresses its intent.
    expect(save.indexOf('hasCanonicalWeek')).toBeLessThan(save.indexOf('bridgeToEngineSlots('));
  });

  it('requires explicit enabled and slots fields instead of silently dropping malformed days', () => {
    expect(save).toContain("typeof day?.enabled !== 'boolean'");
    expect(save).toContain('!Array.isArray(day?.slots)');
    expect(save).toContain('res.status(422)');
  });
});
