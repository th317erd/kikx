import {
  CryptoUtils,
} from 'mythix';

import {
  formatPhoneNumber,
} from './formatter-utils.mjs';

import {
  ErrorBase,
  ForbiddenError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
} from './errors.mjs';

import {
  XID,
  isValidID,
  getModelIDPrefixFor,
  getModelNameFromIDPrefix,
  getModelTypeAndIDFromID,
  stripIDPrefix,
  addIDPrefix,
} from './model-utils.mjs';

import {
  langTerm,
} from './i18n-utils.mjs';

const {
  toBase64,
  convertBase64ToURLSafe,
  convertBase64FromURLSafe,
  toURLSafeBase64,
  fromURLSafeBase64,
  getSaltProperties,
  generateSalt,
  encrypt,
  decrypt,
  hashToken,
  randomBytes,
  randomHash,
  MD5,
  SHA256,
  SHA512,
} = CryptoUtils;

export {
  // crypto-utils
  toBase64,
  convertBase64ToURLSafe,
  convertBase64FromURLSafe,
  toURLSafeBase64,
  fromURLSafeBase64,
  getSaltProperties,
  generateSalt,
  encrypt,
  decrypt,
  hashToken,
  randomBytes,
  randomHash,
  MD5,
  SHA256,
  SHA512,

  // formatter-utils
  formatPhoneNumber,

  // errors
  ErrorBase,
  ForbiddenError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,

  // model-utils
  XID,
  isValidID,
  getModelIDPrefixFor,
  getModelNameFromIDPrefix,
  getModelTypeAndIDFromID,
  stripIDPrefix,
  addIDPrefix,

  // i18n-utils
  langTerm,
};

export default {
  // crypto-utils
  toBase64,
  convertBase64ToURLSafe,
  convertBase64FromURLSafe,
  toURLSafeBase64,
  fromURLSafeBase64,
  getSaltProperties,
  generateSalt,
  encrypt,
  decrypt,
  hashToken,
  randomBytes,
  randomHash,
  MD5,
  SHA256,
  SHA512,

  // formatter-utils
  formatPhoneNumber,

  // errors
  ErrorBase,
  ForbiddenError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,

  // model-utils
  XID,
  isValidID,
  getModelIDPrefixFor,
  getModelNameFromIDPrefix,
  getModelTypeAndIDFromID,
  stripIDPrefix,
  addIDPrefix,

  // i18n-utils
  langTerm,
};
