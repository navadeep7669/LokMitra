import { paiseToRupees } from '../domain/money';
import type { UiLanguage } from '../i18n';

export function buildWhatsAppReminderUrl(
  phone: string,
  customerName: string,
  balancePaise: number,
  language: UiLanguage,
): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  const phoneNumber = digits.length === 10 ? `91${digits}` : digits;
  const balance = paiseToRupees(balancePaise);
  const message =
    language === 'hi'
      ? `नमस्ते ${customerName}, आपकी ${balance} की बाकी राशि के लिए एक विनम्र याद दिला रहा हूँ। धन्यवाद।`
      : language === 'te'
        ? `నమస్కారం ${customerName}, మీ పెండింగ్ మొత్తం ${balance} గురించి ఒక చిన్న గుర్తు. ధన్యవాదాలు.`
        : `Namaste ${customerName}, a gentle reminder about your pending balance of ${balance}. Thank you.`;
  return `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;
}
