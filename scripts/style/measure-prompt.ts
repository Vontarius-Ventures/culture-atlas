/**
 * Prints the byte size of the style call's text input (system prompt, user
 * text with the closed vocabulary, strict JSON schema): the runner bounds it
 * by the profile's maxInputBytes/maxInputTokens. No network.
 * Usage: tsx scripts/style/measure-prompt.ts
 */
import { VLM_STYLE_SYSTEM_PROMPT, VlmStyleReadingSchema, buildVlmStyleUserText, structuredOutputContract } from '../../packages/providers/src/index';
import { closedVocabularyLists } from '../../packages/domain/src/style/vocabulary';

const lists = closedVocabularyLists();
const user = buildVlmStyleUserText({ swatches: [0, 1, 2, 3, 4].map((index) => ({ index, hex: '#7B5A3A', share: 0.2 })), vocabulary: lists });
const schema = JSON.stringify(structuredOutputContract(VlmStyleReadingSchema).jsonSchema);
const sizes = { system: Buffer.byteLength(VLM_STYLE_SYSTEM_PROMPT), user: Buffer.byteLength(user), schema: Buffer.byteLength(schema) };
console.log({ ...sizes, total: sizes.system + sizes.user + sizes.schema, lists: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v?.length ?? 0])) });
