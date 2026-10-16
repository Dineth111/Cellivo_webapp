import { consoleSmsProvider, consoleEmailProvider } from './console.provider.js';

let currentSmsProvider = consoleSmsProvider;
let currentEmailProvider = consoleEmailProvider;

export function getSmsProvider() {
  return currentSmsProvider;
}

export function setSmsProvider(provider) {
  currentSmsProvider = provider;
}

export function getEmailProvider() {
  return currentEmailProvider;
}

export function setEmailProvider(provider) {
  currentEmailProvider = provider;
}

export function resetProviders() {
  currentSmsProvider = consoleSmsProvider;
  currentEmailProvider = consoleEmailProvider;
}

export default {
  getSmsProvider,
  setSmsProvider,
  getEmailProvider,
  setEmailProvider,
  resetProviders,
};
