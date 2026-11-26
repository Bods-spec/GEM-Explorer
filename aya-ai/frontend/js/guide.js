/* ==========================================================================
 * GEM Explorer | AI Museum Guide page (ai.html)
 *
 * What this file does
 *   Chat with Egyxos, the museum guide, through the Node backend:
 *       POST {api.base}/api/ai/guide   { message, conversation_id? }
 *   The Guide answers ONLY from verified museum sources and says so when it cannot find something.
 *   Each answer comes with its sources, shown as clickable citations.
 *
 * What it does NOT do
 *   - It never books anything. A booking request is handed to visit.html (the booking assistant).
 *   - It never builds HTML from the answer: everything is added with textContent / createElement,
 *     and only https links (the answer's own sources, or gem.eg links) become clickable.
 *   - It never stores a token, a message or an answer. The conversation id lives in memory only,
 *     so a page reload starts a new conversation (the server forgets idle conversations after 30 minutes anyway).
 *   - It never shows server error text: every error has a written message in English and Arabic.
 *
 * Sections: 1 Config, 2 Texts, 3 Helpers, 4 Session + request, 5 State, 6 Rendering, 7 Sending, 8 Shell + init
 * ========================================================================== */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const motionReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ======================================================================
   * === 1. CONFIG
   * ==================================================================== */
  const CONFIG = {
    /** The backend address is a FIXED constant and is never read from the URL.
     *  Development: backend http://localhost:3001, page http://localhost:5600 (the backend only accepts that origin).
     *  Change `base` here for deployment. A Guide answer takes 2 or 3 model calls, and the backend itself waits up to
     *  45 s for the Guide, so the browser waits a little longer than that. */
    api: { base: 'http://localhost:3001', guide: '/api/ai/guide', timeoutMs: 50000 },
    timezone: 'Africa/Cairo',
    /** The backend accepts 1 to 500 characters. */
    maxMessageLength: 500,
    counterFrom: 400,
    /** The booking assistant. A booking request is never handled on this page. */
    bookingPage: 'visit.html',
    /** If the backend does not say how long to wait after "too many questions" (browsers hide Retry-After from cross-origin pages
     *  unless the server exposes it), wait this long. The Guide allows 6 questions a minute. */
    rateLimit: { defaultSeconds: 30, maxSeconds: 120 },
    suggestions: { first: 6, followUp: 3 },
    storage: { language: 'gem-explorer-language' }   // same key the homepage and the booking page use
  };

  /* ======================================================================
   * === 2. TEXTS (English and Arabic)
   * Static markup uses data-i18n / data-i18n-attrs; the rest is used from code.
   * Egyxos's own greeting and the example questions use everyday Egyptian Arabic; the page around them follows the site.
   * ==================================================================== */
  const UI = {
    en: {
      /* shared shell (same wording as the other pages) */
      skip: 'Skip to content', navHome: 'Home', navMuseum: 'The Museum', navCollection: 'Collection',
      navExperience: 'Experience', navVisit: 'Plan a Visit', aiGuide: '✦ AI Guide', headerExplore: 'Explore now',
      menuOpen: 'Open menu', menuClose: 'Close menu', langLabel: 'Switch language to Arabic', langButton: 'عربي',
      footerTag: 'Ancient stories. A new perspective.', footerOfficial: 'Official Museum ↗',
      footerDisclaimer: 'Independent educational prototype · Not an official museum service', footerCredits: 'Image credits',
      pageTitle: 'Ask Egyxos | GEM Explorer',
      /* hero */
      heroEyebrow: 'Egyxos museum guide', heroTitleA: 'Ask Egyxos', heroTitleB: 'about the museum.',
      heroSubtitle: 'Questions about the Grand Egyptian Museum, its galleries and its artefacts? Egyxos answers from verified museum sources and shows you where each answer comes from.',
      heroStart: 'Start asking', heroBook: 'Book a visit instead',
      heroCaption: 'EGYXOS · YOUR MUSEUM GUIDE', heroImgAlt: 'Egyxos, the museum guide character',
      /* chat */
      chatTitle: 'Egyxos', chatSub: 'Museum guide · answers with sources', chatStartOver: 'Start over',
      emptyIntro: "Hello! I'm Egyxos. Ask me about the Grand Egyptian Museum: its galleries, artefacts, opening hours and tickets. I answer only from verified museum sources, and I'll tell you when I can't find something.",
      emptyTry: 'Type your own question or tap an example. Arabic and English both work.',
      chipsLabel: 'Suggested questions',
      inputLabel: 'Your question', inputPlaceholder: 'Ask about the museum…', send: 'Send question',
      chatFoot: 'Answers come from verified museum sources. Opening hours and prices can change, so check the official website before you visit. Independent educational prototype.',
      roleUser: 'You said:', typing: 'Egyxos is typing…', retry: 'Try again', retryAfterWait: 'Ask again',
      charCount: (n, max) => `${n} / ${max}`,
      /* answers */
      sourcesTitle: 'Sources', sourceWord: 'Source', newTab: '(opens in a new tab)',
      verified: 'Verified', corroborated: 'Confirmed by several sources', single_source: 'Single source',
      pageEn: 'English page', pageAr: 'Arabic page',
      timeSensitive: 'Time-sensitive · check the official site',
      handoffTitle: 'Ready to book?', handoffText: 'Booking is done in the booking assistant. Your questions here stay as they are.', handoffBtn: 'Open the booking page',
      newConversationNote: 'The previous conversation had expired, so Egyxos started a new one.',
      /* errors (the page never shows server text) */
      guestNotReady: "Your guest session isn't ready yet. Refresh the page, then press Try again.",
      guestExpired: "Egyxos couldn't verify your guest session. Refresh the page, then press Try again.",
      sessionExpired: 'Your session has expired. Please sign in again, then press Try again.',
      errGuests: 'Guest access is not available right now.',
      errRate: (n) => `You're asking quickly. Please wait ${n} second${n === 1 ? '' : 's'} and try again.`,
      errRateDone: 'You can ask again now.',
      errDaily: "You've reached today's limit of questions for the Guide. Please come back tomorrow.",
      errDisabled: 'The museum guide is switched off at the moment.',
      errUnavailable: "The museum guide isn't available right now. Please try again in a moment.",
      errTimeout: 'Egyxos took too long to answer. Please try again.',
      errNetwork: "We couldn't reach the server. Check your connection and try again.",
      errInvalid: "That question couldn't be sent. Please shorten it or rephrase it.",
      chatError: 'Something went wrong. Please try again.',
      errNoAnswer: "Egyxos couldn't answer this time. Please try again."
    },
    ar: {
      skip: 'انتقل للمحتوى', navHome: 'الرئيسية', navMuseum: 'عن المتحف', navCollection: 'المعروضات',
      navExperience: 'التجربة', navVisit: 'خطط لزيارتك', aiGuide: '✦ المرشد الذكي', headerExplore: 'استكشف الآن',
      menuOpen: 'فتح القائمة', menuClose: 'إغلاق القائمة', langLabel: 'تغيير اللغة إلى الإنجليزية', langButton: 'EN',
      footerTag: 'حكايات قديمة. منظور جديد.', footerOfficial: 'الموقع الرسمي ↗',
      footerDisclaimer: 'نموذج تعليمي مستقل · ليس خدمة رسمية للمتحف', footerCredits: 'حقوق الصور',
      pageTitle: 'اسأل Egyxos | GEM Explorer',
      heroEyebrow: 'مرشد المتحف Egyxos', heroTitleA: 'اسأل Egyxos', heroTitleB: 'عن المتحف.',
      heroSubtitle: 'عندك سؤال عن المتحف المصري الكبير أو قاعاته أو قطعه الأثرية؟ يجيبك Egyxos من مصادر المتحف الموثّقة، ويوريك مصدر كل إجابة.',
      heroStart: 'ابدأ بالسؤال', heroBook: 'احجز زيارتك بدلًا من ذلك',
      heroCaption: 'EGYXOS · مرشدك في المتحف', heroImgAlt: 'Egyxos، شخصية مرشد المتحف',
      chatTitle: 'Egyxos', chatSub: 'مرشد المتحف · إجابات بمصادرها', chatStartOver: 'ابدأ من جديد',
      emptyIntro: 'أهلًا! أنا Egyxos. اسألني عن المتحف المصري الكبير: القاعات والقطع الأثرية ومواعيد الزيارة والتذاكر. بجاوب من مصادر المتحف الموثّقة بس، ولو ملقتش المعلومة هقولك صراحةً.',
      emptyTry: 'اكتب سؤالك أو اختر مثالًا. العربية والإنجليزية كلتاهما تعمل.',
      chipsLabel: 'أسئلة مقترحة',
      inputLabel: 'سؤالك', inputPlaceholder: 'اسأل عن المتحف…', send: 'إرسال السؤال',
      chatFoot: 'الإجابات من مصادر المتحف الموثّقة. مواعيد الزيارة والأسعار قد تتغيّر، فتأكد من الموقع الرسمي قبل زيارتك. نموذج تعليمي مستقل.',
      roleUser: 'قلتَ:', typing: 'Egyxos يكتب…', retry: 'أعد المحاولة', retryAfterWait: 'اسأل مرة أخرى',
      charCount: (n, max) => `${n} / ${max}`,
      sourcesTitle: 'المصادر', sourceWord: 'المصدر', newTab: '(يفتح في تبويب جديد)',
      verified: 'موثّق', corroborated: 'مؤكّد من عدة مصادر', single_source: 'مصدر واحد',
      pageEn: 'صفحة بالإنجليزية', pageAr: 'صفحة بالعربية',
      timeSensitive: 'معلومة قد تتغيّر · راجع الموقع الرسمي',
      handoffTitle: 'جاهز للحجز؟', handoffText: 'الحجز يتم من خلال مساعد الحجز. أسئلتك هنا تبقى كما هي.', handoffBtn: 'افتح صفحة الحجز',
      newConversationNote: 'انتهت المحادثة السابقة، فبدأ Egyxos محادثة جديدة.',
      guestNotReady: 'جلسة الضيف الخاصة بك ليست جاهزة بعد. حدّث الصفحة ثم اضغط «أعد المحاولة».',
      guestExpired: 'تعذّر على Egyxos التحقق من جلسة الضيف. حدّث الصفحة ثم اضغط «أعد المحاولة».',
      sessionExpired: 'انتهت جلستك. سجّل الدخول مرة أخرى ثم اضغط «أعد المحاولة».',
      errGuests: 'دخول الضيوف غير متاح الآن.',
      errRate: (n) => `أنت تسأل بسرعة. انتظر ${n} ثانية ثم حاول مرة أخرى.`,
      errRateDone: 'تقدر تسأل مرة أخرى الآن.',
      errDaily: 'وصلت إلى الحد اليومي لأسئلة المرشد. عُد إلينا غدًا.',
      errDisabled: 'مرشد المتحف متوقف مؤقتًا.',
      errUnavailable: 'مرشد المتحف غير متاح الآن. حاول مرة أخرى بعد قليل.',
      errTimeout: 'استغرق Egyxos وقتًا طويلًا في الرد. حاول مرة أخرى.',
      errNetwork: 'تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
      errInvalid: 'تعذّر إرسال هذا السؤال. اختصره أو أعد صياغته.',
      chatError: 'حدث خطأ ما. حاول مرة أخرى.',
      errNoAnswer: 'لم يتمكن Egyxos من الإجابة هذه المرة. حاول مرة أخرى.'
    }
  };

  /** Example questions. Each one is about something in the verified museum notes (Golden Throne, Hanging Obelisk,
   *  Tutankhamun Galleries, opening hours, official tickets, Grand Stairs). The first few show before the first question;
   *  afterwards three that have not been asked yet are offered. */
  const SUGGESTIONS = {
    en: [
      'Tell me about the Golden Throne.',
      'What is the Hanging Obelisk?',
      'What can I see in the Tutankhamun Galleries?',
      'What are the museum opening hours?',
      'Where can I buy official tickets?',
      'Tell me about the Grand Stairs.'
    ],
    ar: [
      'احكيلي عن كرسي العرش الذهبي',
      'احكيلي عن المسلة المعلقة',
      'أقدر أشوف إيه في قاعات توت عنخ آمون؟',
      'المتحف بيفتح امتى؟',
      'فين التذاكر الرسمية؟',
      'احكيلي عن الدرج العظيم'
    ]
  };

  /* ======================================================================
   * === 3. HELPERS
   * ==================================================================== */
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) { /* private mode */ } }
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  const localeOf = (lang) => (lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
  const formatTime = (date, lang) => new Intl.DateTimeFormat(localeOf(lang), { timeZone: CONFIG.timezone, hour: 'numeric', minute: '2-digit' }).format(date);
  /** 'ar' when the text has more Arabic letters than Latin letters, otherwise 'en'. */
  function detectLang(text) {
    const arabic = (text.match(/[؀-ۿ]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return arabic > latin ? 'ar' : 'en';
  }
  /** Our own errors carry `isGuideError`: a browser error (such as AbortError, whose numeric `code` is 20) must not be mistaken for one. */
  const apiError = (code, status, extra) => Object.assign(new Error(code), { code, status, isGuideError: true }, extra);

  /** Only https links are ever made clickable. */
  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' ? url : null;
    } catch (_) { return null; }
  }
  const isOfficialHost = (host) => host === 'gem.eg' || host.endsWith('.gem.eg');
  function externalLink(url, className) {
    const link = el('a', className);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  /* ======================================================================
   * === 4. SESSION + REQUEST
   * ==================================================================== */

  /** Sign-in belongs to the auth teammate (and, for local development, the temporary js/guest-auth.js). This page only asks for
   *  the CURRENT session, in this shape:  { user: { id }, accessToken, expiresAt? (epoch seconds) }  or null.
   *  Nothing here stores or copies a token: it is asked for again before every question. */
  async function getSession() {
    const provider = window.GEMAuth;
    if (!provider || typeof provider.getSession !== 'function') return null;
    let session;
    try { session = await provider.getSession(); } catch (_) { return null; }
    if (!session || !session.user || typeof session.user.id !== 'string' || !session.user.id) return null;
    if (typeof session.accessToken !== 'string' || !session.accessToken) return null;
    if (Number.isFinite(session.expiresAt) && session.expiresAt * 1000 <= Date.now() + 30000) return null;   // 30 s safety margin
    return session;
  }
  /** Temporary Guest Mode sets window.GEMAuth.isGuest. A real login provider does not, so the normal "sign in" wording is used. */
  const guestMode = () => Boolean(window.GEMAuth && window.GEMAuth.isGuest === true);

  const KNOWN_STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope', 'smalltalk', 'handoff', 'unverified', 'unavailable'];

  /** Checks the answer's shape. Anything else is a bad answer, and the visitor sees the generic error. */
  function readAnswer(json) {
    if (!json || typeof json !== 'object' || !KNOWN_STATUSES.includes(json.status)) throw apiError('BAD_RESPONSE');
    if (typeof json.reply !== 'string' || json.reply.trim() === '') throw apiError('BAD_RESPONSE');
    const sources = (Array.isArray(json.sources) ? json.sources : []).filter((source) => (
      source && typeof source === 'object' && typeof source.title === 'string' && source.title !== ''
      && Number.isInteger(source.n) && safeUrl(source.url)
    )).map((source) => ({
      n: source.n,
      title: source.title,
      url: safeUrl(source.url).href,
      verification: typeof source.verification_status === 'string' ? source.verification_status : '',
      timeSensitive: source.time_sensitive === true
    }));
    return {
      status: json.status,
      reply: json.reply,
      sources,
      timeSensitive: json.contains_time_sensitive === true || sources.some((source) => source.timeSensitive),
      handoff: json.status === 'handoff' || (json.handoff && typeof json.handoff === 'object'),
      conversationId: typeof json.conversation_id === 'string' ? json.conversation_id : null,
      lang: json.language === 'ar' ? 'ar' : 'en'
    };
  }

  /** The one place that calls our backend. Success: the Guide's own JSON. Error: { error: 'CODE' } (plus an HTTP status).
   *  Throws apiError(code, status). No valid access token means no request at all. */
  async function askGuide({ message, conversationId, token }) {
    const body = { message };
    if (conversationId) body.conversation_id = conversationId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.api.timeoutMs);
    try {
      const res = await fetch(CONFIG.api.base + CONFIG.api.guide, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const retryAfter = Number.parseInt(res.headers && res.headers.get ? res.headers.get('Retry-After') : '', 10);
        throw apiError(json && typeof json.error === 'string' ? json.error : 'REQUEST_FAILED', res.status, { retryAfter });
      }
      return readAnswer(json);
    } catch (error) {
      if (error.isGuideError) throw error;                            // already one of our errors
      throw apiError(error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Which visitor-facing text (a key in UI) explains this error. */
  function errorKey(error) {
    const code = error && error.code;
    if (code === 'NO_SESSION') return 'guestNotReady';
    if (error.status === 401 || code === 'UNAUTHORIZED') return guestMode() ? 'guestExpired' : 'sessionExpired';
    switch (code) {
      case 'GUESTS_NOT_ALLOWED': return 'errGuests';
      case 'RATE_LIMITED': return 'errRate';
      case 'DAILY_LIMIT_REACHED': return 'errDaily';
      case 'GUIDE_DISABLED': return 'errDisabled';
      case 'GUIDE_UNAVAILABLE': return 'errUnavailable';
      case 'GUIDE_TIMEOUT': case 'TIMEOUT': return 'errTimeout';
      case 'NETWORK_ERROR': return 'errNetwork';
      case 'INVALID_GUIDE_REQUEST': return 'errInvalid';
      default: return 'chatError';
    }
  }
  /** Errors where sending the same question again can help. */
  const retryable = (key) => !['errDaily', 'errDisabled', 'errGuests', 'errInvalid'].includes(key);

  /* ======================================================================
   * === 5. STATE
   * ==================================================================== */
  const state = {
    uiLang: 'en',
    conversationId: null,        // the Guide's id for this conversation (memory only)
    messages: [],                // what is on screen: { role: 'user' | 'ai' | 'note', ... }
    busy: false,
    alert: null,                 // { key, retry, seconds }
    lastFailed: null,            // the question to resend when "Try again" is pressed
    cooldown: { until: 0, timer: null },
    asked: new Set()             // example questions already asked
  };
  const t = () => UI[state.uiLang];

  const ui = {
    header: $('#site-header'), menuToggle: $('#menu-toggle'), langToggle: $('#lang-toggle'),
    log: $('#chat-log'), empty: $('#chat-empty'), emptyChips: $('#empty-chips'), messages: $('#chat-messages'), chips: $('#chat-chips'),
    form: $('#chat-form'), input: $('#chat-input'), send: $('#chat-send'), counter: $('#chat-counter'),
    alert: $('#chat-alert'), alertText: $('#chat-alert-text'), alertRetry: $('#chat-alert-retry'), reset: $('#chat-reset')
  };

  /* ======================================================================
   * === 6. RENDERING
   * ==================================================================== */
  function egyxosAvatar() {
    const wrap = el('span', 'avatar avatar--ai');
    wrap.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.src = 'assets/egyxos-avatar.webp';
    img.alt = '';
    img.width = 96;
    img.height = 96;
    wrap.append(img);
    return wrap;
  }

  /** Text -> nodes. Official gem.eg web addresses in the text become links; every other piece stays plain text. */
  function appendText(parent, text) {
    const re = /https:\/\/[^\s)<>"]+/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0].replace(/[.,;:!?]+$/, '');
      const url = safeUrl(raw);
      if (!url || !isOfficialHost(url.hostname)) continue;
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      const link = externalLink(url.href, 'guide-link');
      link.textContent = raw;
      link.dir = 'ltr';
      parent.append(link);
      last = match.index + raw.length;
      re.lastIndex = last;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  /** The sources of one answer, one entry per web page (the Guide may cite the same page several times). */
  function groupSources(sources) {
    const groups = [];
    const byUrl = new Map();
    const byNumber = new Map();
    sources.forEach((source) => {
      let group = byUrl.get(source.url);
      if (!group) {
        group = { n: groups.length + 1, url: source.url, title: source.title, verification: source.verification };
        groups.push(group);
        byUrl.set(source.url, group);
      }
      byNumber.set(source.n, group);
    });
    return { groups, byNumber };
  }

  /** The answer text, with each [n] turned into a clickable citation (a link to that source). */
  function fillAnswer(bubble, message) {
    const { byNumber } = message.sources;
    const text = message.text;
    const re = /\s*\[(\d{1,2})\]/g;
    let last = 0;
    let lastCited = null;
    let match;
    while ((match = re.exec(text)) !== null) {
      const between = text.slice(last, match.index);
      if (between) { appendText(bubble, between); lastCited = null; }
      const group = byNumber.get(Number(match[1]));
      if (group && group !== lastCited) {                       // an unknown [n] is dropped; the same page twice in a row shows once
        const cite = externalLink(group.url, 'cite');
        cite.textContent = String(group.n);
        cite.title = group.title;
        cite.setAttribute('aria-label', `${t().sourceWord} ${group.n}: ${group.title} ${t().newTab}`);
        // A full stop or comma right after the mark stays on the same line as the mark (no stray "." at the start of a line).
        const punctuation = /^[.,;:!?،؛؟]+/.exec(text.slice(match.index + match[0].length));
        if (punctuation) {
          const joined = el('span', 'cite-join');
          joined.append(cite, document.createTextNode(punctuation[0]));
          bubble.append(joined);
          re.lastIndex = match.index + match[0].length + punctuation[0].length;
        } else {
          bubble.append(cite);
        }
        lastCited = punctuation ? null : group;
      }
      last = re.lastIndex;
    }
    if (last < text.length) appendText(bubble, text.slice(last));
  }

  function pageLangOf(url) {
    const path = new URL(url).pathname;
    if (/(^|\/)ar(\/|$)/.test(path)) return 'ar';
    if (/(^|\/)en(\/|$)/.test(path)) return 'en';
    return null;
  }
  function sourceList(message) {
    const { groups } = message.sources;
    const section = el('section', 'guide-sources');
    section.setAttribute('aria-label', t().sourcesTitle);
    section.append(el('h3', 'guide-sources__title', t().sourcesTitle));
    const list = el('ol', 'guide-sources__list');
    groups.forEach((group) => {
      const item = el('li', 'guide-source');
      const link = externalLink(group.url, 'guide-source__link');
      link.append(el('span', 'guide-source__num', String(group.n)));
      const text = el('span', 'guide-source__text');
      const title = el('span', 'guide-source__title', group.title);
      title.dir = 'auto';
      const meta = [new URL(group.url).hostname];
      const status = t()[group.verification];
      if (typeof status === 'string') meta.push(status);
      const pageLang = pageLangOf(group.url);
      if (pageLang && pageLang !== message.lang) meta.push(pageLang === 'ar' ? t().pageAr : t().pageEn);
      const metaNode = el('span', 'guide-source__meta', meta.join(' · '));
      text.append(title, metaNode, el('span', 'sr', t().newTab));
      link.append(text, el('span', 'guide-source__out', '↗'));
      link.lastChild.setAttribute('aria-hidden', 'true');
      item.append(link);
      list.append(item);
    });
    section.append(list);
    return section;
  }

  function handoffCard() {
    const card = el('div', 'guide-handoff');
    card.append(el('strong', 'guide-handoff__title', t().handoffTitle), el('p', 'guide-handoff__text', t().handoffText));
    const button = el('a', 'btn btn--gold guide-handoff__btn');
    button.href = CONFIG.bookingPage;
    button.append(el('span', '', t().handoffBtn), el('span', '', '↗'));
    button.lastChild.setAttribute('aria-hidden', 'true');
    card.append(button);
    return card;
  }

  function buildMessage(message) {
    if (message.role === 'note') {
      const note = el('p', 'guide-note', t()[message.key]);
      note.setAttribute('role', 'status');
      return note;
    }
    const isUser = message.role === 'user';
    const wrap = el('div', `msg msg--${isUser ? 'user' : 'ai'}`);
    const avatar = isUser ? el('span', 'avatar avatar--user') : egyxosAvatar();
    if (isUser) { avatar.setAttribute('aria-hidden', 'true'); avatar.append(icon('user')); }
    const main = el('div', 'msg__main');
    const bubble = el('div', 'msg__bubble');
    bubble.lang = message.lang;
    bubble.dir = 'auto';
    if (isUser) bubble.textContent = message.text;               // textContent: never HTML
    else fillAnswer(bubble, message);
    const time = el('time', 'msg__time', formatTime(new Date(message.at), state.uiLang));
    time.dateTime = message.at;
    main.append(isUser ? el('span', 'sr', t().roleUser) : el('span', 'msg__name', 'Egyxos'), bubble);
    if (!isUser && message.sources.groups.length > 0) main.append(sourceList(message));
    if (!isUser && message.timeSensitive) {
      const tag = el('p', 'guide-tag');
      tag.append(icon('info'), el('span', '', t().timeSensitive));
      main.append(tag);
    }
    if (!isUser && message.handoff) main.append(handoffCard());
    main.append(time);
    wrap.append(avatar, main);
    return wrap;
  }

  function scrollToBottom() { ui.log.scrollTo({ top: ui.log.scrollHeight, behavior: motionReduced ? 'auto' : 'smooth' }); }
  /** A new answer is read from its first line, not from its last. */
  function scrollToAnswer(node) { ui.log.scrollTo({ top: Math.max(0, node.offsetTop - 12), behavior: motionReduced ? 'auto' : 'smooth' }); }

  function addMessage(message) {
    message.at = message.at || new Date().toISOString();
    state.messages.push(message);
    const node = buildMessage(message);
    ui.messages.append(node);
    if (message.role === 'ai') scrollToAnswer(node); else scrollToBottom();
    renderChips();
  }
  function renderAll() {
    ui.messages.replaceChildren(...state.messages.map(buildMessage));
    if (state.busy) showTyping();
    renderChips();
    scrollToBottom();
  }

  function showTyping() {
    if ($('.msg--typing', ui.messages)) return;
    const wrap = el('div', 'msg msg--ai msg--typing');
    wrap.setAttribute('role', 'status');
    const bubble = el('div', 'msg__bubble');
    bubble.append(el('span', 'typing-dot'), el('span', 'typing-dot'), el('span', 'typing-dot'), el('span', 'sr', t().typing));
    const main = el('div', 'msg__main');
    main.append(bubble);
    wrap.append(egyxosAvatar(), main);
    ui.messages.append(wrap);
    scrollToBottom();
  }
  const hideTyping = () => { const node = $('.msg--typing', ui.messages); if (node) node.remove(); };

  function makeChip(label) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.lang = state.uiLang;
    chip.addEventListener('click', () => sendMessage(label));
    return chip;
  }
  const inCooldown = () => state.cooldown.until > Date.now();
  function renderChips() {
    const none = state.messages.length === 0;
    ui.empty.hidden = !none;
    const pool = SUGGESTIONS[state.uiLang];
    ui.emptyChips.replaceChildren(...pool.slice(0, CONFIG.suggestions.first).map(makeChip));
    const next = none ? [] : pool.filter((label) => !state.asked.has(label)).slice(0, CONFIG.suggestions.followUp);
    ui.chips.hidden = next.length === 0;
    ui.chips.replaceChildren(...next.map(makeChip));
    $$('.chip').forEach((chip) => { chip.disabled = state.busy || inCooldown(); });
  }

  function renderAlert() {
    const alert = state.alert;
    ui.alert.hidden = !alert;
    if (!alert) return;
    const text = t()[alert.key];
    ui.alertText.textContent = typeof text === 'function' ? text(alert.seconds) : text;
    ui.alertRetry.hidden = !alert.retry;
    ui.alertRetry.disabled = inCooldown();
    ui.alertRetry.textContent = alert.key === 'errRateDone' ? t().retryAfterWait : t().retry;
  }
  function showAlert(key, { retry = true, seconds = 0 } = {}) { state.alert = { key, retry, seconds }; renderAlert(); }
  function hideAlert() { state.alert = null; renderAlert(); }

  function updateControls() {
    const blocked = state.busy || inCooldown();
    ui.send.disabled = blocked || ui.input.value.trim() === '';
    ui.alertRetry.disabled = blocked;
    ui.form.setAttribute('aria-busy', String(state.busy));
    $$('.chip').forEach((chip) => { chip.disabled = blocked; });
    const length = ui.input.value.length;
    ui.counter.hidden = length < CONFIG.counterFrom;
    ui.counter.textContent = t().charCount(length, CONFIG.maxMessageLength);
    ui.counter.classList.toggle('is-full', length >= CONFIG.maxMessageLength);
  }

  /* ---- rate-limit countdown ---- */
  function stopCooldown() {
    if (state.cooldown.timer) clearInterval(state.cooldown.timer);
    state.cooldown = { until: 0, timer: null };
  }
  function startCooldown(seconds) {
    stopCooldown();
    state.cooldown.until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.ceil((state.cooldown.until - Date.now()) / 1000);
      if (left <= 0) {
        stopCooldown();
        showAlert('errRateDone');
        updateControls();
        return;
      }
      showAlert('errRate', { seconds: left });
      updateControls();
    };
    tick();
    state.cooldown.timer = setInterval(tick, 1000);
  }

  /* ======================================================================
   * === 7. SENDING
   * ==================================================================== */
  async function sendMessage(raw, { retry = false } = {}) {
    const text = String(raw).trim();
    if (!text || text.length > CONFIG.maxMessageLength || state.busy || inCooldown()) return;
    hideAlert();
    if (!retry) {
      addMessage({ role: 'user', text, lang: detectLang(text) });
      ui.input.value = '';
    }
    if (SUGGESTIONS[state.uiLang].includes(text)) state.asked.add(text);
    state.lastFailed = null;
    state.busy = true;
    showTyping();
    updateControls();
    try {
      let restarted = false;
      for (;;) {
        const session = await getSession();                      // asked again before every question: nothing is cached
        if (!session) throw apiError('NO_SESSION');
        try {
          const answer = await askGuide({ message: text, conversationId: state.conversationId, token: session.accessToken });
          hideTyping();
          if (answer.status === 'unavailable') throw apiError('NO_ANSWER');   // the Guide could not answer this time (and did not remember the turn)
          state.conversationId = answer.conversationId || state.conversationId;
          addMessage({
            role: 'ai', text: answer.reply, lang: answer.lang, status: answer.status,
            sources: groupSources(answer.sources), timeSensitive: answer.timeSensitive, handoff: answer.handoff
          });
          break;
        } catch (error) {
          // The conversation expired or was lost (the Guide forgets idle conversations): start a new one, once, and ask again.
          if (error.code === 'CONVERSATION_NOT_FOUND' && state.conversationId && !restarted) {
            restarted = true;
            state.conversationId = null;
            hideTyping();
            addMessage({ role: 'note', key: 'newConversationNote' });
            showTyping();
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      hideTyping();
      state.lastFailed = text;
      if (error.code === 'NO_ANSWER') { showAlert('errNoAnswer'); return; }
      const key = errorKey(error);
      if (key === 'errRate') {
        const asked = Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : CONFIG.rateLimit.defaultSeconds;
        startCooldown(Math.min(asked, CONFIG.rateLimit.maxSeconds));
      } else {
        showAlert(key, { retry: retryable(key) });
      }
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function resetConversation() {
    stopCooldown();
    state.conversationId = null;
    state.messages = [];
    state.asked = new Set();
    state.lastFailed = null;
    state.busy = false;
    hideTyping();
    hideAlert();
    ui.messages.replaceChildren();
    ui.input.value = '';
    renderChips();
    updateControls();
    ui.log.scrollTo({ top: 0 });
    ui.input.focus({ preventScroll: true });
  }

  /* ======================================================================
   * === 8. SHELL + INIT
   * The homepage's behaviour lives in js/app.js, which is homepage-only, so the few pieces this page needs
   * (sticky header, menu, language) are repeated here, as on the booking page.
   * ==================================================================== */
  function setMenuOpen(isOpen) {
    ui.header.classList.toggle('is-menu-open', isOpen);
    ui.menuToggle.setAttribute('aria-expanded', String(isOpen));
    ui.menuToggle.setAttribute('aria-label', t()[isOpen ? 'menuClose' : 'menuOpen']);
  }
  function applyI18n() {
    const dict = t();
    $$('[data-i18n]').forEach((node) => { const value = dict[node.dataset.i18n]; if (typeof value === 'string') node.textContent = value; });
    $$('[data-i18n-attrs]').forEach((node) => node.dataset.i18nAttrs.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':');
      if (typeof dict[key] === 'string') node.setAttribute(attr, dict[key]);
    }));
  }
  function setLanguage(lang) {
    state.uiLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    applyI18n();
    ui.langToggle.textContent = t().langButton;
    ui.langToggle.setAttribute('aria-label', t().langLabel);
    ui.menuToggle.setAttribute('aria-label', t()[ui.header.classList.contains('is-menu-open') ? 'menuClose' : 'menuOpen']);
    document.title = t().pageTitle;
    renderAll();
    renderAlert();
    updateControls();
    store.set(CONFIG.storage.language, lang);
  }

  function bindEvents() {
    ui.langToggle.addEventListener('click', () => setLanguage(state.uiLang === 'en' ? 'ar' : 'en'));
    ui.menuToggle.addEventListener('click', () => setMenuOpen(!ui.header.classList.contains('is-menu-open')));
    $$('.main-nav a, .brand').forEach((link) => link.addEventListener('click', () => setMenuOpen(false)));
    window.addEventListener('resize', () => { if (window.innerWidth > 800) setMenuOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenuOpen(false); });
    window.addEventListener('scroll', () => {
      ui.header.classList.toggle('is-sticky', window.scrollY > 45);
      const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      $('#scroll-progress').style.width = `${Math.min(100, (window.scrollY / range) * 100)}%`;
    });

    ui.input.maxLength = CONFIG.maxMessageLength;
    ui.input.addEventListener('input', updateControls);
    ui.form.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(ui.input.value); });
    ui.alertRetry.addEventListener('click', () => { if (state.lastFailed) sendMessage(state.lastFailed, { retry: true }); });
    ui.reset.addEventListener('click', resetConversation);
    $('#hero-start').addEventListener('click', () => setTimeout(() => ui.input.focus({ preventScroll: true }), motionReduced ? 0 : 500));
  }

  function init() {
    const saved = store.get(CONFIG.storage.language);
    const year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());
    bindEvents();
    setLanguage(saved === 'ar' ? 'ar' : 'en');
    getSession();      // start the (guest) session now, so the first question is not slowed down by it
  }
  init();
})();