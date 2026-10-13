/**
 * Restores question marks the speech model left out, in English and Spanish.
 *
 * The model punctuates mostly from intonation, so questions read flat can end in a period
 * or nothing. Spanish yes/no questions suffer most: "Puedes revisar el archivo" is a
 * statement and a question with the same words. A sentence is turned into a question only
 * when its opening words make that unambiguous; an existing "?" or "!" is never touched.
 */

/** Openers a sentence may start with before the question proper: "So can you…", "Y cuánto…". */
const LEAD = String.raw`(?:(?:so|and|but|okay|ok|also|then|now|hey|well|y|pero|entonces|oye|vale|bueno)[,\s]+)*`;

const SUBJECTS = "you|i|we|they|he|she|it|this|that|these|those|there|the|a|an|my|your|our|their|its|any|anyone|anything|someone|something|everything|everyone";

const ENGLISH = [
  // Modal or "be" before a subject: "Can you…", "Is this…", "Should the…".
  String.raw`(?:can|could|would|will|should|shall|may|might|must|is|are|was|were|does|did|has|isn't|aren't|wasn't|weren't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|hasn't)\s+(?:${SUBJECTS})\b`,
  // "Do" and "have" also start commands ("Do it now", "Have a look"), so only before a person.
  String.raw`(?:do|don't|have|haven't|am)\s+(?:you|i|we|they)\b`,
  // Question word before a verb: "Why is…", "What does…". "What I mean is…" stays a statement.
  String.raw`(?:what|why|how|where|when|which|who|whose)\s+(?:is|are|was|were|do|does|did|can|could|would|should|will|has|have|had)\b`,
  String.raw`(?:what's|where's|how's|who's|how\s+(?:much|many|long|often|far))\b`,
].map((pattern) => new RegExp(`^${LEAD}${pattern}`, "iu"));

/** A trailing tag: "…, right", "…, isn't it". */
const ENGLISH_TAG = /,\s*(?:right|isn't it|aren't they|don't you think)$/iu;

const SPANISH = [
  // Accented question words are interrogative by spelling: "Cómo…", "Por qué…".
  String.raw`(?:qué|por\s+qué|cómo|cuándo|dónde|adónde|cuál|cuáles|quién|quiénes|cuánto|cuánta|cuántos|cuántas)(?=\s|$)`,
  // A request or offer: "Puedes revisar…", "Lo podrías probar…", "Te parece bien…".
  String.raw`(?:(?:me|te|lo|la|le|los|las|nos|les|se)\s+)?(?:puedes|podrías|podés|podéis|quieres|querés|querrías)(?=\s)`,
  String.raw`te\s+parece(?=\s|$)`,
].map((pattern) => new RegExp(`^${LEAD}${pattern}`, "iu"));

/** "…, verdad" or "…, ¿verdad". */
const SPANISH_TAG = /,\s*¿?verdad$/iu;

/** Sentences with their closing marks, and the space after. A "." inside "3.5" does not split. */
const SENTENCE = /\S.*?(?:[.!?]+(?=\s|$)|$)\s*/gsu;

export function restoreQuestionMarks(text: string): string {
  return text.replace(SENTENCE, (sentence) => {
    const [, body = "", marks = "", space = ""] = /^(.*?)([.!?]*)(\s*)$/su.exec(sentence) ?? [];
    if (/[?!]/.test(marks) || body === "") return sentence;
    const question = asQuestion(body);
    return question === undefined ? sentence : `${question}?${space}`;
  });
}

/** The sentence body rewritten as a question, or undefined when it does not read as one. */
function asQuestion(body: string): string | undefined {
  const tag = SPANISH_TAG.exec(body);
  if (tag) return `${body.slice(0, tag.index)}, ¿verdad`;
  // An opening "¿" the model wrote without the closing mark.
  if (body.includes("¿")) return body;
  if (SPANISH.some((pattern) => pattern.test(body))) return `¿${body}`;
  if (ENGLISH_TAG.test(body) || ENGLISH.some((pattern) => pattern.test(body))) return body;
  return undefined;
}
