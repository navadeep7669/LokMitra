import type { Customer } from './events';
import { levenshteinDistanceAtMostOne, phoneticKey, transliterate } from './transliteration';

export type RankedCustomer = { customer: Customer; score: number; matched_alias: string };

function customerTokens(value: string): string[] {
  return phoneticKey(value).split(/\s+/).filter(Boolean);
}

function scoreAlias(queryTokens: string[], alias: string): number {
  const aliasTokens = customerTokens(alias);
  if (!aliasTokens.length || !queryTokens.length) return 0;
  let exact = 0;
  let fuzzy = 0;
  for (const token of aliasTokens) {
    const match = queryTokens.find((queryToken) => queryToken === token);
    if (match) {
      exact += 1;
      continue;
    }
    if (token.length < 4) continue;
    if (queryTokens.some((queryToken) => queryToken.length >= 4 && levenshteinDistanceAtMostOne(queryToken, token) === 1)) fuzzy += 1;
  }
  if (!exact && !fuzzy) return 0;
  if (exact === aliasTokens.length) return 1;
  if (exact) return Math.min(0.94, 0.86 + (exact - 1) * 0.07 + fuzzy * 0.02);
  return 0.72;
}

export function matchCustomerCandidates(query: string, customers: Customer[]): RankedCustomer[] {
  const queryTokens = customerTokens(query);
  if (!queryTokens.length) return [];
  return customers
    .map((customer) => {
      const aliases = [...new Set([customer.display_name, ...(customer.aliases ?? [])])];
      const rankedAliases = aliases
        .map((alias) => ({ alias, score: scoreAlias(queryTokens, alias) }))
        .sort((left, right) => right.score - left.score);
      const best = rankedAliases[0];
      return best ? { customer, score: best.score, matched_alias: best.alias } : null;
    })
    .filter((result): result is RankedCustomer => result !== null && result.score >= 0.65)
    .sort((left, right) => right.score - left.score || left.customer.display_name.localeCompare(right.customer.display_name))
    .slice(0, 3);
}

export function buildCustomerAliases(displayName: string, aliases: string[] = []): string[] {
  const result = new Set([displayName.trim(), ...aliases.map((alias) => alias.trim()).filter(Boolean)]);
  const romanized = transliterate(displayName)
    .toLocaleLowerCase()
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (romanized) result.add(romanized);
  return [...result];
}
