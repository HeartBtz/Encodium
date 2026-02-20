/* ═══════════════════════════════════════════════════════════
   Encodium — Internationalization (i18n) engine
   ═══════════════════════════════════════════════════════════ */

;(function () {
  'use strict';

  const STORAGE_KEY = 'enc_lang';
  const DEFAULT_LANG = 'fr';
  const AVAILABLE = {};   // populated via registerLang()
  let current = {};       // active translation dict
  let currentLang = DEFAULT_LANG;

  /** Register a language pack */
  function registerLang(code, translations) {
    AVAILABLE[code] = translations;
  }

  /** Get list of available languages (for selector) */
  function getLanguages() {
    return Object.keys(AVAILABLE).map(code => ({
      code,
      name: (AVAILABLE[code] && AVAILABLE[code]._name) || code,
      flag: (AVAILABLE[code] && AVAILABLE[code]._flag) || '',
    }));
  }

  /** Get current language code */
  function getLang() { return currentLang; }

  /** Set active language and re-translate the DOM */
  function setLang(code) {
    if (!AVAILABLE[code]) code = DEFAULT_LANG;
    currentLang = code;
    current = AVAILABLE[code] || {};
    localStorage.setItem(STORAGE_KEY, code);
    document.documentElement.lang = code;
    translateDOM();
  }

  /**
   * Translate a key, with optional interpolation.
   *   t('toast.n_selected', { n: 5 })  →  "5 sélectionné(s)"
   * Placeholders in strings are {key}.
   */
  function t(key, params) {
    let str = current[key];
    if (str === undefined) {
      // Fallback to French, then to the key itself
      const fb = AVAILABLE[DEFAULT_LANG];
      str = fb ? fb[key] : undefined;
      if (str === undefined) return key;
    }
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
      }
    }
    return str;
  }

  /** Translate all elements with data-i18n attributes */
  function translateDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) el.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) el.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) el.title = translated;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const translated = t(key);
      if (translated !== key) el.innerHTML = translated;
    });
  }

  /** Initialize: load saved language or detect from browser */
  function init() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && AVAILABLE[saved]) {
      setLang(saved);
    } else {
      // Try browser language
      const nav = (navigator.language || '').substring(0, 2).toLowerCase();
      setLang(AVAILABLE[nav] ? nav : DEFAULT_LANG);
    }
  }

  // Expose globally
  window.i18n = { registerLang, getLanguages, getLang, setLang, t, init, translateDOM };
})();
