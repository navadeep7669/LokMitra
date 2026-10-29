import hindi from './transliteration/hi.json';
import telugu from './transliteration/te.json';

type ScriptTable = {
  consonants: Record<string, string>;
  vowels: Record<string, string>;
  matras: Record<string, string>;
  special: Record<string, string>;
};

const tables: Array<{ start: number; end: number; table: ScriptTable }> = [
  { start: 0x0900, end: 0x097f, table: hindi },
  { start: 0x0c00, end: 0x0c7f, table: telugu },
];

export function transliterate(text: string): string {
  const characters = Array.from(text.normalize('NFC'));
  let result = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const code = character.codePointAt(0) ?? 0;
    const script = tables.find((candidate) => code >= candidate.start && code <= candidate.end);
    if (!script) {
      result += character;
      continue;
    }
    const { consonants, vowels, matras, special } = script.table;
    const consonant = consonants[character];
    if (consonant) {
      const next = characters[index + 1];
      if (next && Object.prototype.hasOwnProperty.call(matras, next)) {
        result += consonant.slice(0, -1) + matras[next];
        index += 1;
      } else {
        result += consonant;
      }
      continue;
    }
    result += vowels[character] ?? matras[character] ?? special[character] ?? ' ';
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function phoneticKey(value: string): string {
  const withoutHonorifics = value.replace(
    /(^|\s)(ji|bhai|garu|anna|akka|sahab|गारु|जी|भाई|अन्ना|अक्का|साहब|గారు|అన్న|అక్క|సాహెబ్)(?=\s|$)/giu,
    ' ',
  );
  return transliterate(withoutHonorifics)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ee|ii/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/bh/g, 'b')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/ph/g, 'f')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/sh/g, 's')
    .replace(/chh/g, 'ch')
    .replace(/cch/g, 'ch')
    .replace(/v/g, 'w')
    .replace(/a+/g, 'a')
    .replace(/i+/g, 'i')
    .replace(/u+/g, 'u')
    .replace(/e+/g, 'e')
    .replace(/o+/g, 'o')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => token.length > 3 ? token.replace(/[aeiou]$/, '') : token)
    .filter((token) => !['ji', 'bhai', 'garu', 'anna', 'akka', 'sahab'].includes(token))
    .join(' ');
}

export function levenshteinDistanceAtMostOne(left: string, right: string): number | null {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return null;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return null;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1 ? edits : null;
}
