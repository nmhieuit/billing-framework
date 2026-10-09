import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv và ajv-formats là CJS; tùy bundler/runtime mà default import là hàm hoặc { default }.
const unwrap = <T>(mod: T | { default: T }): T =>
  typeof mod === 'function' ? mod : (mod as { default: T }).default;

const Ajv2020 = unwrap(Ajv2020Module);
const addFormats = unwrap(addFormatsModule);

export const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
