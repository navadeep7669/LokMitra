import { describe, expect, it } from 'vitest';
import { buildWhatsAppReminderUrl } from './reminders';

describe('WhatsApp reminders', () => {
  it('builds a prefilled country-coded URL and politely localizes it', () => {
    const url = buildWhatsAppReminderUrl('98765 43210', 'Ravi', 50000, 'te');
    expect(url).toContain('https://wa.me/919876543210?text=');
    expect(decodeURIComponent(url ?? '')).toContain('నమస్కారం Ravi');
    expect(decodeURIComponent(url ?? '')).toContain('₹500.00');
  });

  it('does not build a link for missing or implausible phone numbers', () => {
    expect(buildWhatsAppReminderUrl('', 'Ravi', 1, 'en')).toBeNull();
    expect(buildWhatsAppReminderUrl('1234567890123456', 'Ravi', 1, 'en')).toBeNull();
  });
});
