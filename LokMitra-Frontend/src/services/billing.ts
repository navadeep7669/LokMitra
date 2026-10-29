import { z } from 'zod';
import { gstInPaise, type Invoice, type Plan, type PlanKey } from '../domain/events';

export const PLANS: Plan[] = [
  { key: 'free', name: 'Free', monthly_paise: 0, yearly_paise: 0, speech_minutes: 30, customer_limit: 100, features: ['Local voice ledger', 'CSV export', 'Offline records'] },
  { key: 'pro', name: 'Pro', monthly_paise: 19900, yearly_paise: 199000, speech_minutes: 300, customer_limit: 1000, features: ['300 speech minutes', 'Unlimited local ledger', 'Priority support'] },
  { key: 'business', name: 'Business', monthly_paise: 49900, yearly_paise: 499000, speech_minutes: 1200, customer_limit: 5000, features: ['1,200 speech minutes', 'Team-ready workspace', 'Business reports'] },
];
export const checkoutInputSchema = z.object({ plan_key: z.enum(['free', 'pro', 'business']), billing_period: z.enum(['monthly', 'yearly']) });
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export type CheckoutOutcome = 'success' | 'failure' | 'pending';
export type CheckoutSession = { id: string; plan_key: PlanKey; amount_paise: number; status: 'created' | CheckoutOutcome };
export interface PaymentService {
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  confirmPayment(session: CheckoutSession, outcome: CheckoutOutcome): Promise<CheckoutSession>;
}
export const mockPaymentService: PaymentService = {
  async createCheckout(input) {
    const valid = checkoutInputSchema.parse(input);
    const plan = PLANS.find((item) => item.key === valid.plan_key)!;
    return { id: crypto.randomUUID(), plan_key: valid.plan_key, amount_paise: valid.billing_period === 'yearly' ? plan.yearly_paise : plan.monthly_paise, status: 'created' };
  },
  async confirmPayment(session, outcome) { return { ...session, status: outcome }; },
};
export function createInvoice(merchantId: string, planKey: PlanKey, subtotalPaise: number, status: Invoice['status']): Invoice {
  const gst = gstInPaise(subtotalPaise);
  return {
    id: crypto.randomUUID(), merchant_id: merchantId, invoice_number: `LM-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    plan_key: planKey, subtotal_paise: subtotalPaise, gst_paise: gst, total_paise: subtotalPaise + gst, status, created_at: Date.now(),
  };
}
