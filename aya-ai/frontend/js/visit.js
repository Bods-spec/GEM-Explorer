/**
 * GEM Explorer | Visit page: AI booking assistant (FRONTEND ONLY)
 *
 * The browser talks to OUR Node.js backend only (/api/...). It never calls n8n,
 * OpenAI or Supabase directly: the n8n webhook URL, its secret and all keys stay
 * on the server. Understanding the visitor's text (date, number of visitors, name,
 * intent) is done by the Egyxos agent in n8n. This file only sends messages, shows
 * replies, keeps the booking summary, validates input and shows loading and error states.
 *
 * The backend is the source of truth for bookings: a booking is created INSIDE the
 * chat call (POST /api/ai/chat with the latest confirmation_revision) and the real
 * booking_reference comes back from there. This page never creates a booking itself
 * and never calls POST /api/bookings.
 *
 * Default mode is the real API. Open visit.html?mode=mock for the isolated sandbox:
 * a small rule-based mock (section 4) plays the assistant, nothing leaves the browser
 * and nothing is ever created for real.
 *
 * File layout (search for the "=== N." markers):
 *
 *   1. CONFIG            switches and limits
 *   2. TRANSLATIONS      UI strings (EN/AR) + assistant replies
 *   3. DATES/VALIDATION  Africa/Cairo date helpers, validation, shared draft helpers
 *   4. MOCK AGENT        temporary rule-based "AI" (delete when n8n is connected)
 *   5. SERVICES          AuthAdapter, Booking and Chat services (real API by default, mock on request)
 *   6. STATE
 *   7. RENDERING         summary, chat, history (textContent only, no innerHTML)
 *   8. CONTROLLERS       chat flow, confirm flow, history loading
 *   9. SHELL + INIT      header behaviour shared with the homepage, language
 *
 * Integration seams are marked with "INTEGRATION:".
 * User text is only ever inserted with textContent / createTextNode.
 */
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const motionReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ======================================================================
   * === 1. CONFIG
   * ==================================================================== */
  /** Test switches are read from the URL only:  ?mode=mock   ?fail=booking|chat   ?history=empty|error|slow
   *  They never change WHERE the page sends requests: the backend address below is fixed in this file. */
  const query = new URLSearchParams(window.location.search);

  const CONFIG = {
    /** 'api' = the real Node backend (default). 'mock' = isolated sandbox (section 4): no network, nothing is created for real. */
    mode: query.get('mode') === 'mock' ? 'mock' : 'api',
    /** INTEGRATION: the backend address is a FIXED constant and is never read from the URL.
     *  Development: backend http://localhost:3001, page http://localhost:5600 (the backend only accepts that origin).
     *  Change `base` here for deployment. The chatbot runs inside the Node backend (no n8n, no AI service),
     *  so a plain booking reply normally takes well under a second. 45 s covers a visit plan: the backend waits up to 15 s for the
     *  planner and then still has to answer, so the browser must wait longer than that. */
    api: { base: 'http://localhost:3001', chat: '/api/ai/chat', bookings: '/api/bookings', timeoutMs: 45000 },
    timezone: 'Africa/Cairo',
    minVisitors: 1,
    maxVisitors: 10,
    /** Soft limit so absurd dates (year 2099) are rejected with a clear message. */
    maxDaysAhead: 365,
    /** The backend accepts up to 2000 characters. 500 leaves room for a plan request and a booking in one message. */
    maxMessageLength: 500,
    latency: { chatMin: 650, chatMax: 1100, booking: 1300, history: 900, historySlow: 3000 },
    storage: {
      language: 'gem-explorer-language',   // same key the homepage uses
      bookings: 'gem-demo-bookings-v1'
    }
  };

  /* ======================================================================
   * === 2. TRANSLATIONS
   * Visitor-facing strings live here (same pattern as js/app.js on the homepage).
   * Strings are applied via data-i18n / data-i18n-attrs; nested objects and
   * functions are used from code.
   * ==================================================================== */
  const UI = {
    en: {
      /* shared shell (copied from app.js so the header/footer match the homepage) */
      skip: 'Skip to content', navHome: 'Home', navMuseum: 'The Museum', navCollection: 'Collection',
      navExperience: 'Experience', navVisit: 'Plan a Visit', aiGuide: '✦ AI Guide', headerExplore: 'Explore now',
      menuOpen: 'Open menu', menuClose: 'Close menu', langLabel: 'Switch language to Arabic', langButton: 'عربي',
      footerTag: 'Ancient stories. A new perspective.', footerOfficial: 'Official Museum ↗',
      footerDisclaimer: 'Independent educational prototype · Not an official museum service', footerCredits: 'Image credits',
      pageTitle: 'Book Your Visit with AI | GEM Explorer',
      /* hero */
      heroEyebrow: 'Egyxos booking assistant', heroTitleA: 'Book your visit', heroTitleB: 'with AI.',
      heroSubtitle: "Let Egyxos, our AI assistant, help you create a booking for your visit to the Grand Egyptian Museum. Just chat, and we'll take care of the details.",
      heroStart: 'Start chatting', heroHow: 'See opening hours',
      planTitle: 'Before you book',
      planP1: "The Grand Egyptian Museum stands beside the Giza Pyramids. A visit can take in the Tutankhamun Galleries, the Main Galleries, the Grand Hall and Grand Stairs, the Khufu's Boats Museum and the gardens.",
      planP2: 'Chat with Egyxos below to choose a date and the number of visitors (1 to 10).',
      planNote: 'This is a student project. It creates demo bookings only and is not the official GEM ticketing site. For real tickets, use the official museum website.',
      planLink: 'Official museum website',
      hoursTitle: 'Opening Hours', hoursTag: 'Cairo time',
      hoursDaysA: 'Sunday, Monday, Tuesday, Thursday, Friday', hoursDaysB: 'Saturday, Wednesday',
      hoursComplex: 'GEM Complex', hoursGalleries: 'Galleries', hoursLast: 'Last ticket sale',
      hoursNote: 'Last entry is one hour before the galleries close. Hours can change, for example during Ramadan, so check the official website before you travel.',
      heroImgAlt: 'The Grand Staircase of the Grand Egyptian Museum at night, with visitors',
      heroCaption: 'THE GRAND STAIRCASE',
      /* chat */
      chatTitle: 'Egyxos',
      chatStartOver: 'Start over',
      emptyIntro: "Hello! I'm Egyxos, your museum booking assistant. When would you like to visit?",
      emptyTry: 'Type your own message or tap an example. Arabic and English both work.',
      inputLabel: 'Your message', inputPlaceholder: 'Type a message, e.g. “I want to visit tomorrow”', send: 'Send message',
      roleUser: 'You:', typing: 'Egyxos is typing…',
      chatError: "Egyxos couldn't reply. Your message was not lost.", retry: 'Try again',
      authRequired: 'Please sign in to chat with Egyxos and manage your bookings.',
      sessionExpired: 'Your session has expired. Please sign in again, then press Try again.',
      /* temporary Guest Mode (window.GEMAuth.isGuest): the visitor is never asked to sign in */
      guestNotReady: "Your guest session isn't ready yet. Please refresh the page and try again.",
      guestExpired: "Egyxos couldn't verify your guest session. Refresh the page, then press Try again.",
      errNetwork: "We couldn't reach the server. Check your connection and try again.",
      errTimeout: 'Egyxos took too long to answer. Please try again. If you were confirming a booking, check your bookings below first.',
      errStale: 'Your booking details changed since the last summary. Ask Egyxos to show the summary again, then confirm.',
      errNeedName: 'We still need the name for the booking before it can be confirmed.',
      errDraftGone: 'That booking request is no longer active. Press Start over to begin a new one.',
      errInvalid: 'Some booking details are not valid. Please check the date and the number of visitors.',
      /* summary */
      summaryTitle: 'Booking Summary',
      fieldName: 'Visitor Name', fieldDate: 'Visit Date', fieldVisitors: 'Visitors', fieldStatus: 'Booking Status', fieldRef: 'Booking Reference',
      notSet: 'Not set yet',
      visitorsValue: (n) => `${n} ${n === 1 ? 'visitor' : 'visitors'}`,
      status: { draft: 'Draft', awaiting: 'Awaiting Confirmation', confirmed: 'Confirmed', failed: 'Failed', cancelled: 'Cancelled' },
      confirmBtn: 'Confirm Demo Booking', confirming: 'Creating your demo booking…', retryBtn: 'Try again',
      hint: {
        both: 'Tell the assistant a date and the number of visitors to continue.',
        date: 'Still needed: the visit date.',
        visitors: 'Still needed: the number of visitors.',
        invalid: 'Fix the highlighted detail to continue.',
        ready: 'Check the details, then confirm. Nothing is booked until you do.',
        confirmed: "Demo booking created. It's now in your history below.",
        failed: 'The demo booking could not be created. Nothing was saved. You can try again.',
        name: 'Still needed: the name for the booking.',
        review: 'Ask Egyxos to show your booking summary, then confirm.',
        plan: 'Finish your visit plan first, or choose “Booking only” to skip it.',
        planDown: 'The visit plan is not available right now. Choose “Booking only” to continue.',
        signIn: 'Sign in to chat with Egyxos and make a booking.',
        guest: "Your guest session isn't ready. Refresh the page to try again."
      },
      err: {
        date: {
          invalid: "That isn't a valid date. Use a format like YYYY-MM-DD, or say “tomorrow”.",
          past: 'That date has already passed. Choose today or a later date.',
          far: 'Choose a date within the next 12 months.'
        },
        visitors: { int: 'Visitors must be a whole number.', range: 'Visitors must be between 1 and 10.' }
      },
      /* history */
      historyTitle: 'My Recent Bookings',
      viewAll: (n) => `View all (${n})`, showFewer: 'Show fewer',
      histLoading: 'Loading your demo bookings…',
      histEmptyTitle: 'No demo bookings yet', histEmptyText: 'Confirm a booking in the chat above and it will appear here.', histEmptyBtn: 'Start a booking',
      histErrorTitle: "We couldn't load your bookings", histErrorText: 'Something went wrong. Please try again.',
      histSignInTitle: 'Sign in to see your bookings', histSignInText: 'Your bookings appear here once you are signed in.',
      histGuestTitle: "Your bookings aren't available yet", histGuestText: "Your guest session isn't ready. Refresh the page to try again.",
      cardVisitDate: 'Visit date', cardVisitors: 'Visitors', cardRef: 'Reference', cardCreated: 'Created',
    },
    ar: {
      skip: 'انتقل للمحتوى', navHome: 'الرئيسية', navMuseum: 'عن المتحف', navCollection: 'المعروضات',
      navExperience: 'التجربة', navVisit: 'خطط لزيارتك', aiGuide: '✦ المرشد الذكي', headerExplore: 'استكشف الآن',
      menuOpen: 'فتح القائمة', menuClose: 'إغلاق القائمة', langLabel: 'تغيير اللغة إلى الإنجليزية', langButton: 'EN',
      footerTag: 'حكايات قديمة. منظور جديد.', footerOfficial: 'الموقع الرسمي ↗',
      footerDisclaimer: 'نموذج تعليمي مستقل · ليس خدمة رسمية للمتحف', footerCredits: 'حقوق الصور',
      pageTitle: 'احجز زيارتك بالذكاء الاصطناعي | GEM Explorer',
      heroEyebrow: 'مساعد الحجز Egyxos', heroTitleA: 'احجز زيارتك', heroTitleB: 'بالذكاء الاصطناعي',
      heroSubtitle: 'دع Egyxos، مساعدنا الذكي، يساعدك في إنشاء حجز لزيارتك إلى المتحف المصري الكبير. تحدّث معنا فقط، ونحن نتولى التفاصيل.',
      heroNotice: 'حجز Egyxos فقط — وليس تذكرة رسمية من المتحف المصري الكبير. لا حاجة لأي دفع.',
      heroStart: 'ابدأ المحادثة', heroHow: 'ساعات العمل',
      planTitle: 'قبل أن تحجز',
      planP1: 'يقع المتحف المصري الكبير بجوار أهرامات الجيزة. يمكن أن تشمل زيارتك قاعات توت عنخ آمون والقاعات الرئيسية والقاعة الكبرى والدرج العظيم ومتحف مراكب خوفو والحدائق.',
      planP2: 'تحدّث مع Egyxos في الأسفل لاختيار التاريخ وعدد الزوار (من 1 إلى 10).',
      planNote: 'هذا مشروع طلابي. ينشئ حجوزات تجريبية فقط وليس موقع التذاكر الرسمي للمتحف. للحصول على تذاكر حقيقية، استخدم الموقع الرسمي للمتحف.',
      planLink: 'الموقع الرسمي للمتحف',
      hoursTitle: 'مواعيد العمل', hoursTag: 'بتوقيت القاهرة',
      hoursDaysA: 'الأحد والاثنين والثلاثاء والخميس والجمعة', hoursDaysB: 'السبت والأربعاء',
      hoursComplex: 'مجمّع المتحف', hoursGalleries: 'قاعات العرض', hoursLast: 'آخر بيع للتذاكر',
      hoursNote: 'آخر دخول قبل إغلاق القاعات بساعة. قد تتغير المواعيد، مثلًا في رمضان، فتحقق من الموقع الرسمي قبل سفرك.',
      heroImgAlt: 'الدرج العظيم في المتحف المصري الكبير ليلًا مع الزوار',
      heroCaption: 'الدرج العظيم',
      chatTitle: 'Egyxos',
      chatStartOver: 'ابدأ من جديد',
      emptyIntro: 'أهلًا بك! أنا Egyxos، مساعدك لحجز زيارة المتحف. متى تود الزيارة؟',
      emptyTry: 'اكتب رسالتك أو اختر أحد الأمثلة. يمكنك الكتابة بالعربية أو الإنجليزية.',
      inputLabel: 'رسالتك', inputPlaceholder: 'اكتب رسالتك، مثل: «أريد زيارة المتحف غدًا»', send: 'إرسال الرسالة',
      roleUser: 'أنت:', typing: 'Egyxos يكتب…',
      chatFoot: 'حجز تجريبي فقط وليس تذكرة رسمية. من فضلك لا تُدخل بيانات دفع أو كلمات مرور.',
      chatError: 'تعذّر على Egyxos الرد. رسالتك لم تُفقد.', retry: 'أعد المحاولة',
      authRequired: 'سجّل الدخول أولًا للتحدث مع Egyxos وإدارة حجوزاتك.',
      sessionExpired: 'انتهت جلستك. سجّل الدخول مرة أخرى ثم اضغط «أعد المحاولة».',
      guestNotReady: 'جلسة الضيف الخاصة بك ليست جاهزة بعد. حدّث الصفحة وحاول مرة أخرى.',
      guestExpired: 'تعذّر على Egyxos التحقق من جلسة الضيف. حدّث الصفحة ثم اضغط «أعد المحاولة».',
      errNetwork: 'تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
      errTimeout: 'استغرق Egyxos وقتًا طويلًا في الرد. حاول مرة أخرى. وإن كنت تؤكد حجزًا فتحقق من حجوزاتك أدناه أولًا.',
      errStale: 'تغيّرت تفاصيل حجزك منذ آخر ملخص. اطلب من Egyxos عرض الملخص مرة أخرى ثم أكّد.',
      errNeedName: 'ما زلنا بحاجة إلى اسم صاحب الحجز قبل التأكيد.',
      errDraftGone: 'طلب الحجز هذا لم يعد نشطًا. اضغط «ابدأ من جديد» لبدء حجز جديد.',
      errInvalid: 'بعض تفاصيل الحجز غير صالحة. تحقق من التاريخ وعدد الزوار.',
      summaryTitle: 'ملخص الحجز',
      fieldName: 'اسم الزائر', fieldDate: 'تاريخ الزيارة', fieldVisitors: 'عدد الزوار', fieldStatus: 'حالة الحجز', fieldRef: 'الرقم المرجعي للحجز',
      notSet: 'لم يُحدَّد بعد',
      visitorsValue: (n) => (n === 1 ? 'زائر واحد' : n === 2 ? 'زائران' : n <= 10 ? `${n} زوار` : `${n} زائرًا`),
      status: { draft: 'مسودة', awaiting: 'بانتظار التأكيد', confirmed: 'تم التأكيد', failed: 'فشل الحجز', cancelled: 'ملغي' },
      confirmBtn: 'تأكيد الحجز التجريبي', confirming: 'جارٍ إنشاء حجزك التجريبي…', retryBtn: 'أعد المحاولة',
      newBooking: 'ابدأ حجزًا جديدًا', stampA: 'حجز تجريبي', stampB: 'ليس تذكرة رسمية',
      hint: {
        both: 'أخبر المساعد بالتاريخ وعدد الزوار للمتابعة.',
        date: 'ما زلنا بحاجة إلى تاريخ الزيارة.',
        visitors: 'ما زلنا بحاجة إلى عدد الزوار.',
        invalid: 'صحّح البيان المميّز للمتابعة.',
        ready: 'راجع التفاصيل ثم أكّد. لن يُنشأ أي حجز قبل تأكيدك.',
        confirmed: 'تم إنشاء الحجز التجريبي. ستجده الآن في سجلّك أدناه.',
        failed: 'تعذّر إنشاء الحجز التجريبي ولم يُحفظ شيء. يمكنك المحاولة مرة أخرى.',
        name: 'ما زلنا بحاجة إلى الاسم الذي سيُسجَّل به الحجز.',
        review: 'اطلب من Egyxos عرض ملخص حجزك ثم أكّد.',
        plan: 'أكمل خطة الزيارة أولًا، أو اختر «الحجز بس» لتخطّيها.',
        planDown: 'خطة الزيارة غير متاحة الآن. اختر «الحجز بس» للمتابعة.',
        signIn: 'سجّل الدخول للتحدث مع Egyxos وإنشاء حجز.',
        guest: 'جلسة الضيف ليست جاهزة. حدّث الصفحة وحاول مرة أخرى.'
      },
      err: {
        date: {
          invalid: 'هذا التاريخ غير صالح. استخدم صيغة مثل YYYY-MM-DD أو اكتب «غدًا».',
          past: 'هذا التاريخ مضى بالفعل. اختر اليوم أو تاريخًا لاحقًا.',
          far: 'اختر تاريخًا خلال الأشهر الاثني عشر القادمة.'
        },
        visitors: { int: 'عدد الزوار يجب أن يكون رقمًا صحيحًا.', range: 'عدد الزوار يجب أن يكون بين 1 و10.' }
      },
      historyTitle: 'حجوزاتي التجريبية الأخيرة', historyLead: 'تظهر هنا حجوزاتك التجريبية فقط.',
      viewAll: (n) => `عرض الكل (${n})`, showFewer: 'عرض أقل',
      histLoading: 'جارٍ تحميل حجوزاتك التجريبية…',
      histEmptyTitle: 'لا توجد حجوزات تجريبية بعد', histEmptyText: 'أكّد حجزًا في المحادثة أعلاه وسيظهر هنا.', histEmptyBtn: 'ابدأ حجزًا',
      histErrorTitle: 'تعذّر تحميل حجوزاتك', histErrorText: 'حدث خطأ ما. حاول مرة أخرى.',
      histSignInTitle: 'سجّل الدخول لعرض حجوزاتك', histSignInText: 'تظهر حجوزاتك هنا بعد تسجيل الدخول.',
      histGuestTitle: 'حجوزاتك غير متاحة بعد', histGuestText: 'جلسة الضيف ليست جاهزة. حدّث الصفحة وحاول مرة أخرى.',
      cardVisitDate: 'تاريخ الزيارة', cardVisitors: 'عدد الزوار', cardRef: 'الرقم المرجعي', cardCreated: 'أُنشئ في',
    }
  };

  /** Suggested replies. Every string here is a phrase the mock agent understands. */
  const EMPTY_CHIPS = ['I want to visit tomorrow', 'We are 3 people', 'Plan a 2-hour visit', 'أريد زيارة المتحف غدًا', 'نحن 3 أشخاص', 'خطة زيارة لمدة ساعتين'];
  const CHIPS = {
    en: {
      both: ['I want to visit tomorrow', 'Day after tomorrow for 2 people'],
      date: ['Tomorrow', 'Day after tomorrow', 'In 7 days'],
      visitors: ['Just me', '2 people', '4 people'],
      confirm: ['Yes, confirm', 'Change something'],
      name: [],                                   // the visitor types their own name
      review: ['Show my booking summary'],
      plan: ['Booking only'],                     // a requested visit plan is not finished yet
      planDown: ['Booking only', 'Plan a 2-hour visit'],   // the planner is unavailable: skip it, or ask again
      planned: ['Make it 90 minutes', 'I want to visit tomorrow', 'Day after tomorrow for 2 people']   // a plan was just shown
    },
    ar: {
      both: ['أريد زيارة المتحف غدًا', 'بعد غد لشخصين'],
      date: ['غدًا', 'بعد غد', 'بعد 7 أيام'],
      visitors: ['أنا لوحدي', 'شخصان', '4 أشخاص'],
      confirm: ['نعم، أكّد', 'أريد التعديل'],
      name: [],
      review: ['اعرض ملخص حجزي'],
      plan: ['الحجز بس'],
      planDown: ['الحجز بس', 'خطة زيارة لمدة ساعتين'],
      planned: ['اجعلها 90 دقيقة', 'أريد زيارة المتحف غدًا', 'بعد غد لشخصين']
    }
  };
  /** INTEGRATION: in API mode the confirm message must be one of the explicit phrases the backend accepts
   *  (backend/confirm-booking.js). The Confirm button and the "Yes" chip send exactly these. */
  const CONFIRM_PHRASE = { en: 'Yes confirm', ar: 'أيوه أكد الحجز' };

  /** Assistant replies, one function per situation, per language. */
  const REPLIES = {
    en: {
      greet: "Hello! I'm Egyxos, your museum booking assistant.",
      askBoth: 'When would you like to visit, and how many people will come (1–10)?',
      askDate: (vis) => `Great! I have ${vis}. When would you like to visit?`,
      askVisitors: (date) => `Great! I've noted ${date}. How many people will be visiting (1–10)?`,
      ready: (date, vis) => `Perfect! Let me show you your demo booking summary:\nDate: ${date}\nVisitors: ${vis}\nWould you like to confirm? Reply “yes” or press Confirm Demo Booking.`,
      updated: 'Updated.',
      dateError: { invalid: "That isn't a valid date. Use a format like YYYY-MM-DD, or say “tomorrow”.", past: 'That date has already passed. Choose today or a later date.', far: 'Please choose a date within the next 12 months.' },
      visitorsError: { int: 'The number of visitors must be a whole number.', range: 'The number of visitors must be between 1 and 10.' },
      unclear: "I didn't quite understand that. I can help with a visit date and the number of visitors. Try “tomorrow” and “3 people”.",
      notReady: (missing) => `I can't confirm yet. I still need: ${missing}.`,
      missingDate: 'the visit date', missingVisitors: 'the number of visitors', and: ' and ',
      changeWhat: 'No problem. What would you like to change: the date or the number of visitors?',
      reset: "I've cleared the draft. Which day would you like to visit, and how many people will come?",
      alreadyConfirmed: (ref) => `This booking is already confirmed (reference ${ref}). Say “new booking” to start another.`,
      success: (ref) => `Your demo booking has been created successfully. Your reference is ${ref}.`,
      failure: "I couldn't create the demo booking this time, and nothing was saved. You can try again.",
      duplicate: "You already have a demo booking for that date. You can find it in your history below, or choose another date."
    },
    ar: {
      greet: 'أهلًا بك! أنا Egyxos، مساعدك لحجز زيارة المتحف.',
      askBoth: 'متى تود الزيارة، وكم عدد الأشخاص (من 1 إلى 10)؟',
      askDate: (vis) => `رائع! سجّلتُ ${vis}. متى تود الزيارة؟`,
      askVisitors: (date) => `رائع! سجّلتُ الموعد: ${date}. كم عدد الأشخاص الذين سيزورون المتحف (من 1 إلى 10)؟`,
      ready: (date, vis) => `ممتاز! دعني أعرض عليك ملخص حجزك التجريبي:\nالتاريخ: ${date}\nعدد الزوار: ${vis}\nهذا حجز تعليمي تجريبي وليس تذكرة رسمية من المتحف المصري الكبير. هل تريد التأكيد؟ اكتب «نعم» أو اضغط زر «تأكيد الحجز التجريبي».`,
      updated: 'تم التحديث.',
      dateError: { invalid: 'هذا التاريخ غير صالح. استخدم صيغة مثل YYYY-MM-DD أو اكتب «غدًا».', past: 'هذا التاريخ مضى بالفعل. اختر اليوم أو تاريخًا لاحقًا.', far: 'من فضلك اختر تاريخًا خلال الأشهر الاثني عشر القادمة.' },
      visitorsError: { int: 'عدد الزوار يجب أن يكون رقمًا صحيحًا.', range: 'عدد الزوار يجب أن يكون بين 1 و10.' },
      unclear: 'لم أفهم رسالتك جيدًا. يمكنني مساعدتك في اختيار تاريخ الزيارة وعدد الزوار. جرّب مثلًا «غدًا» و«3 أشخاص».',
      notReady: (missing) => `لا يمكنني التأكيد بعد. ما زلت أحتاج إلى: ${missing}.`,
      missingDate: 'تاريخ الزيارة', missingVisitors: 'عدد الزوار', and: ' و',
      changeWhat: 'لا مشكلة. ماذا تريد تغييره: التاريخ أم عدد الزوار؟',
      reset: 'تم مسح المسودة. في أي يوم تود الزيارة، وكم عدد الأشخاص؟',
      alreadyConfirmed: (ref) => `تم تأكيد هذا الحجز بالفعل (الرقم المرجعي ${ref}). اكتب «حجز جديد» لبدء حجز آخر.`,
      success: (ref) => `تم إنشاء حجزك التجريبي بنجاح. الرقم المرجعي: ${ref}. تذكير: هذا حجز تعليمي وليس تذكرة رسمية من المتحف المصري الكبير.`,
      failure: 'تعذّر إنشاء الحجز التجريبي هذه المرة ولم يُحفظ شيء. يمكنك المحاولة مرة أخرى.',
      duplicate: 'لديك حجز تجريبي بالفعل في هذا التاريخ. يمكنك رؤيته في سجلّك أدناه، أو اختيار تاريخ آخر.'
    }
  };

  /* ======================================================================
   * === 3. DATES AND VALIDATION  (Africa/Cairo, no hard-coded dates)
   * Visit dates are plain calendar dates as 'YYYY-MM-DD' (matches the
   * visit_date field in docs/API_CONTRACT.md).
   * ==================================================================== */
  const pad = (n) => String(n).padStart(2, '0');
  const localeOf = (lang) => (lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');

  function cairoYMD(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const pick = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: pick('year'), m: pick('month'), d: pick('day') };
  }
  const toISO = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
  const todayISO = () => toISO(cairoYMD());

  /** Returns {y,m,d} only for a real calendar date (rejects 2026-02-30). */
  function parseISO(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!match) return null;
    const y = +match[1], m = +match[2], d = +match[3];
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { y, m, d };
  }
  function addDays(iso, n) {
    const p = parseISO(iso);
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return toISO({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
  }
  const weekdayOf = (iso) => { const p = parseISO(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); };
  function daysBetween(fromISO, toISOString) {
    const a = parseISO(fromISO), b = parseISO(toISOString);
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }

  /** @returns {{ok:true}|{ok:false, code:'invalid'|'past'|'far'}} */
  function validateDate(iso) {
    if (!parseISO(iso)) return { ok: false, code: 'invalid' };
    const today = todayISO();
    if (iso < today) return { ok: false, code: 'past' };
    if (daysBetween(today, iso) > CONFIG.maxDaysAhead) return { ok: false, code: 'far' };
    return { ok: true };
  }
  /** @returns {{ok:true}|{ok:false, code:'int'|'range'}} Only whole numbers 1-10 are valid. */
  function validateVisitors(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, code: 'int' };
    if (n < CONFIG.minVisitors || n > CONFIG.maxVisitors) return { ok: false, code: 'range' };
    return { ok: true };
  }

  function formatDate(iso, lang) {
    const p = parseISO(iso);
    if (!p) return '';
    // Noon UTC rendered in Cairo time always lands on the same calendar day.
    return new Intl.DateTimeFormat(localeOf(lang), { timeZone: CONFIG.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(Date.UTC(p.y, p.m - 1, p.d, 12)));
  }
  const formatTime = (date, lang) => new Intl.DateTimeFormat(localeOf(lang), { timeZone: CONFIG.timezone, hour: 'numeric', minute: '2-digit' }).format(date);
  const formatDateTime = (isoString, lang) => new Intl.DateTimeFormat(localeOf(lang), { timeZone: CONFIG.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(isoString));

  /** The real reference comes from the backend (booking_reference). Only the sandbox mock derives one from its id. */
  const bookingReference = (booking) => (typeof booking.booking_reference === 'string' && booking.booking_reference
    ? booking.booking_reference
    : `GEM-DEMO-${String(booking.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`);

  /* ---- Shared draft helpers (used by the page itself, not only by the mock) ---- */
  /** 'ar' if the text contains Arabic letters, 'en' if it contains Latin letters, otherwise the fallback. */
  function detectLang(raw, fallback) {
    if (/[؀-ۿ]/.test(raw)) return 'ar';
    if (/[a-z]/i.test(raw)) return 'en';
    return fallback;
  }
  /** Same rule as the backend: 2-100 characters, letters, marks, spaces and . ' ’ - only. The backend checks it again. */
  const isValidVisitorName = (value) => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 100 && /^[\p{L}\p{M}\s.'’-]+$/u.test(value.trim());
  const isDraftValid = (draft) => Boolean(draft.visitDate && draft.visitors !== null && validateDate(draft.visitDate).ok && validateVisitors(draft.visitors).ok);
  /** Which question is currently open, derived from the draft. */
  function pendingAskFor(draft) {
    if (isDraftValid(draft)) return 'confirm';
    if (!draft.visitDate && draft.visitors === null) return 'both';
    return draft.visitDate ? 'visitors' : 'date';
  }

  /* ======================================================================
   * === 4. MOCK AGENT
   * A small rule-based stand-in for the future AI agent. It does NOT understand
   * natural language; it recognises the phrases listed below and asks the
   * visitor to clarify otherwise.
   *
   * Dates:     today, tomorrow, day after tomorrow, yesterday (rejected as past),
   *            in N days/weeks, next week, weekday names (next upcoming one),
   *            2026-11-05, 5/11/2026 (day first), "5 November [2026]", "November 5"
   *            AR: اليوم، غدًا/بكرة، بعد غد، أمس، بعد N أيام/يومين/أسبوع،
   *                أيام الأسبوع (الجمعة…)، 5 نوفمبر
   * Visitors:  "3 people/visitors/guests/tickets", "we are 3", "for two", "just me",
   *            "two of us", a bare number when asked; AR: "3 أشخاص"، "ثلاثة أشخاص"،
   *            "شخصين"، "لوحدي"، "نحن 3"
   * Confirm:   yes / confirm / ok / sure …  نعم / أكّد / موافق …
   * Other:     hello/help, no/change, "new booking"/"start over"/cancel
   * Weekday names resolve to the nearest upcoming day (1-7 days ahead).
   * Day/month dates without a year use the current year in Cairo.
   * ==================================================================== */
  const EN_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20 };
  const AR_NUM = { واحد: 1, واحده: 1, اثنين: 2, اثنان: 2, اتنين: 2, ثلاثه: 3, ثلاث: 3, تلاته: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, ثمانيه: 8, ثماني: 8, تمانيه: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10, عشرين: 20 };
  const MONTHS = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12, يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };
  const EN_WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const AR_WEEKDAYS = { احد: 0, اثنين: 1, ثلاثاء: 2, اربعاء: 3, خميس: 4, جمعه: 5, سبت: 6 };
  const byLength = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join('|');
  const NUM = `-?\\d+(?:\\.\\d+)?|${byLength({ ...EN_NUM, ...AR_NUM })}`;
  const MONTH_RE = byLength(MONTHS);
  const START = '(?:^|\\s)', END = '(?=\\s|$)';
  const numValue = (token) => (/^-?\d/.test(token) ? Number(token) : (EN_NUM[token] ?? AR_NUM[token]));

  const RX = {
    iso: new RegExp(`${START}(\\d{4})-(\\d{1,2})-(\\d{1,2})${END}`),
    dmy: new RegExp(`${START}(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${END}`),
    dayMonth: new RegExp(`${START}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|من\\s+)?(${MONTH_RE})(?:\\s+(\\d{4}))?${END}`),
    monthDay: new RegExp(`${START}(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?${END}`),
    rel: [
      [new RegExp(`${START}(?:day after tomorrow|بعد غد|بعد بكره|بعد بكرا)${END}`), 2],
      [new RegExp(`${START}(?:tomorrow|tmrw|tomorow|غدا|غد|بكره|بكرا)${END}`), 1],
      [new RegExp(`${START}(?:today|tonight|اليوم|النهارده|انهارده)${END}`), 0],
      [new RegExp(`${START}(?:yesterday|امس|مبارح)${END}`), -1],
      [new RegExp(`${START}(?:in a week|next week)${END}`), 7]
    ],
    inN: new RegExp(`${START}(?:in|after)\\s+(${NUM})\\s+(days?|weeks?)${END}`),
    inNAr: new RegExp(`${START}بعد\\s+(?:(${NUM})\\s+)?(يومين|اسبوعين|يوم|ايام|اسبوع|اسابيع)${END}`),
    weekdayEn: new RegExp(`${START}(?:(?:next|this|on|coming)\\s+)?(${Object.keys(EN_WEEKDAYS).join('|')})${END}`),
    weekdayAr: new RegExp(`${START}(?:يوم\\s+)?[بلو]?ال(${Object.keys(AR_WEEKDAYS).join('|')})${END}`)
  };
  const NOUN = 'people|persons?|visitors?|guests?|adults?|tickets?|pax|seats?|of us|اشخاص|شخص|زوار|زائر|افراد|فرد|تذاكر|تذكره|نفر|انفار';
  const RX_VIS = {
    noun: new RegExp(`${START}(${NUM})\\s*(?:${NOUN})${END}`),
    lead: new RegExp(`${START}(?:we are|were|we will be|there are|there will be|party of|group of|total of|total|visitors|guests|number of (?:people|visitors|guests)|for|نحن|احنا|عددنا|عدد الاشخاص|عدد الزوار|عدد)\\s+(${NUM})${END}`),
    solo: new RegExp(`${START}(?:just me|only me|myself|by myself|alone|solo|انا لوحدي|انا فقط|انا بس|لوحدي|وحدي)${END}`),
    dual: new RegExp(`${START}ل?(?:شخصين|شخصان|فردين|زائرين|تذكرتين|both of us|the two of us)${END}`),
    bare: new RegExp(`^(${NUM})$`)
  };
  const RX_INTENT = {
    confirm: /^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|please confirm|yes please|yes confirm|yes i confirm|looks good|correct|that is correct|book it|confirm booking|confirm demo booking|نعم|ايوه|ايوا|اجل|تمام|اكيد|موافق|تاكيد|اكد|اكد الحجز|تاكيد الحجز|نعم اكد|نعم تاكيد|ايوه اكد)$/,
    deny: /^(?:no|nope|nah|not yet|wait|change|change it|change something|change the date|تعديل|لا|لا شكرا|مش دلوقتي|غير|اريد التعديل|اريد تعديل)$/,
    reset: /(?:start over|reset|new booking|another booking|restart|cancel|clear|ابدا من جديد|حجز جديد|الغاء|الغي|من البدايه|اعاده)/,
    greet: /^(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|help|start|مرحبا|اهلا|السلام عليكم|هلا|صباح الخير|مساء الخير|مساعده|ساعدني)(?:\s|$)/
  };

  /** Lower-case, Arabic-Indic digits to 0-9, strip diacritics, unify letter variants, drop punctuation. */
  function normalize(raw) {
    return String(raw).toLowerCase()
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/['’`]/g, '')
      .replace(/[,،;؛:!?؟"“”«»()]+/g, ' ')
      .replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  const visitorsText = (n, lang) => UI[lang].visitorsValue(n);

  /** MOCK ONLY: true when the visitor just says hello. The mock then greets by itself. Delete with the mock. */
  const isGreeting = (message) => RX_INTENT.greet.test(normalize(message));

  /** @returns {{iso:string, matched:string}|null}. iso may be an invalid date; validateDate() decides. */
  function extractDate(text) {
    let m;
    if ((m = RX.iso.exec(text))) return { iso: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, matched: m[0] };
    if ((m = RX.dmy.exec(text))) return { iso: `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`, matched: m[0] };   // day first (Egypt)
    const year = cairoYMD().y;
    if ((m = RX.dayMonth.exec(text))) return { iso: `${m[3] || year}-${pad(MONTHS[m[2]])}-${pad(+m[1])}`, matched: m[0] };
    if ((m = RX.monthDay.exec(text))) return { iso: `${m[3] || year}-${pad(MONTHS[m[1]])}-${pad(+m[2])}`, matched: m[0] };
    const today = todayISO();
    for (const [rx, offset] of RX.rel) if ((m = rx.exec(text))) return { iso: addDays(today, offset), matched: m[0] };
    if ((m = RX.inN.exec(text))) {
      const n = numValue(m[1]);
      return { iso: addDays(today, Math.round(n * (m[2].startsWith('week') ? 7 : 1))), matched: m[0] };
    }
    if ((m = RX.inNAr.exec(text))) {
      const unit = m[2];
      const n = unit === 'يومين' ? 2 : unit === 'اسبوعين' ? 14 : (m[1] ? numValue(m[1]) : 1) * (unit.startsWith('اسبوع') || unit === 'اسابيع' ? 7 : 1);
      return { iso: addDays(today, n), matched: m[0] };
    }
    const target = (m = RX.weekdayEn.exec(text)) ? EN_WEEKDAYS[m[1]] : (m = RX.weekdayAr.exec(text)) ? AR_WEEKDAYS[m[1]] : null;
    if (target !== null && m) {
      const ahead = ((target - weekdayOf(today) + 6) % 7) + 1;   // 1..7 days ahead
      return { iso: addDays(today, ahead), matched: m[0] };
    }
    return null;
  }

  /** @returns {number|null} raw candidate (may be out of range / fractional; validateVisitors() decides). */
  function extractVisitors(text, { allowBare }) {
    let m;
    if ((m = RX_VIS.noun.exec(text)) || (m = RX_VIS.lead.exec(text))) return numValue(m[1]);
    if (RX_VIS.solo.test(text)) return 1;
    if (RX_VIS.dual.test(text)) return 2;
    if (allowBare && (m = RX_VIS.bare.exec(text))) return numValue(m[1]);
    return null;
  }


  /**
   * INTEGRATION: the real agent will be reached through ChatService.sendMessage()
   * with the same input and a result of the same shape.
   *
   * @param {{message:string, draft:{visitDate:string|null, visitors:number|null}, status:string,
   *          reference:string|null, uiLanguage:'en'|'ar', chatLanguage:'en'|'ar'}} input
   * @returns {{lang:'en'|'ar', reply:string, extracted:{visit_date?:string, ticket_count?:number},
   *            action:null|'confirm'|'reset'}}
   *   `extracted` holds raw, UNVALIDATED candidates (names follow POST /api/bookings).
   *   The page validates them again, so a real LLM cannot bypass the rules.
   */
  function runMockAgent({ message, draft, status, reference, uiLanguage, chatLanguage }) {
    const lang = detectLang(message, chatLanguage || uiLanguage);
    const R = REPLIES[lang];
    const text = normalize(message);
    const result = { lang, reply: '', extracted: {}, action: null };

    if (status === 'confirmed') {
      if (RX_INTENT.reset.test(text)) { result.action = 'reset'; result.reply = R.reset; }
      else result.reply = R.alreadyConfirmed(reference);
      return result;
    }
    if (RX_INTENT.reset.test(text)) { result.action = 'reset'; result.reply = R.reset; return result; }

    const ready = isDraftValid(draft);
    if (RX_INTENT.confirm.test(text)) {
      if (ready) { result.action = 'confirm'; return result; }
      const missing = [];
      if (!draft.visitDate) missing.push(R.missingDate);
      if (draft.visitors === null) missing.push(R.missingVisitors);
      result.reply = R.notReady(missing.join(R.and));
      return result;
    }
    if (RX_INTENT.deny.test(text) && ready) { result.reply = R.changeWhat; return result; }

    // Extract: date first, then remove it so day numbers are not mistaken for visitors.
    const dateHit = extractDate(text);
    const rest = dateHit ? text.replace(dateHit.matched, ' ') : text;
    const pending = pendingAskFor(draft);
    const visitorsHit = extractVisitors(rest, { allowBare: pending === 'visitors' });
    if (dateHit) result.extracted.visit_date = dateHit.iso;
    if (visitorsHit !== null) result.extracted.ticket_count = visitorsHit;

    const attempted = Boolean(dateHit) || visitorsHit !== null;
    if (!attempted) {
      const next = pendingAskFor(draft);
      const ask = next === 'both' ? R.askBoth : next === 'date' ? R.askDate(visitorsText(draft.visitors, lang)) : next === 'visitors' ? R.askVisitors(formatDate(draft.visitDate, lang)) : R.ready(formatDate(draft.visitDate, lang), visitorsText(draft.visitors, lang));
      result.reply = RX_INTENT.greet.test(text) ? `${R.greet} ${ask}` : `${R.unclear}${next === 'confirm' ? '' : `\n\n${ask}`}`;
      return result;
    }

    // Build the draft as the page will see it after validation.
    const next = { visitDate: draft.visitDate, visitors: draft.visitors };
    const errors = [];
    if (dateHit) {
      const check = validateDate(dateHit.iso);
      if (check.ok) next.visitDate = dateHit.iso; else { next.visitDate = null; errors.push(R.dateError[check.code]); }
    }
    if (visitorsHit !== null) {
      const check = validateVisitors(visitorsHit);
      if (check.ok) next.visitors = visitorsHit; else { next.visitors = null; errors.push(R.visitorsError[check.code]); }
    }
    const ask = isDraftValid(next)
      ? `${ready ? `${R.updated}\n` : ''}${R.ready(formatDate(next.visitDate, lang), visitorsText(next.visitors, lang))}`
      : (() => { const k = pendingAskFor(next); return k === 'both' ? R.askBoth : k === 'date' ? R.askDate(visitorsText(next.visitors, lang)) : R.askVisitors(formatDate(next.visitDate, lang)); })();
    result.reply = errors.length ? `${errors.join('\n')}\n\n${ask}` : ask;
    return result;
  }

  /* ======================================================================
   * === 5. SERVICES
   * The page only talks to Services.auth / Services.booking / Services.chat.
   * CONFIG.mode picks the Api* services (real backend, default) or the mock
   * (section 4 and the Mock* services, sandbox only).
   * ==================================================================== */
  /** Test switches (see CONFIG). They only change the mock; they are not part of the real service contract.
   *  fail=booking | chat makes the next mock call fail once. */
  const mockOptions = {
    failBooking: query.get('fail') === 'booking',
    failChat: query.get('fail') === 'chat',
    historyMode: ['slow', 'empty', 'error'].includes(query.get('history')) ? query.get('history') : 'normal'
  };

  const apiError = (code, message, status) => Object.assign(new Error(message || code), { code, status });
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/[x]/g, () => ((Math.random() * 16) | 0).toString(16)));
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) { /* private mode */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch (_) { /* private mode */ } }
  };
  /** INTEGRATION: the one place that calls our backend. Success answer { data: ... }, error answer { error: 'CODE' }.
   *  Throws apiError(code, message, status). Two hard rules live here:
   *  - mock mode never uses the network, so it can never create anything for real;
   *  - no valid access token means no request at all. */
  async function requestJson(path, { method = 'GET', body, token } = {}) {
    if (CONFIG.mode !== 'api') throw apiError('MOCK_MODE');
    if (!token) throw apiError('UNAUTHENTICATED');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.api.timeoutMs);   // stop waiting after timeoutMs
    try {
      const res = await fetch(CONFIG.api.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(typeof json.error === 'string' ? json.error : 'REQUEST_FAILED', json.message, res.status);
      return json.data;
    } catch (error) {
      if (error.code) throw error;                                   // already one of our errors
      throw apiError(error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
  /* ---- 5a. Auth ----
   * Sign-in, registration and the Supabase Auth client belong to the auth teammate. This page only needs the
   * CURRENT SESSION, in this shape:   { user: { id: string }, accessToken: string, expiresAt?: number (epoch seconds) }
   * or null when nobody is signed in. AuthAdapter is the only code that knows where that session comes from.
   * INTEGRATION (auth teammate): connect it by making the shared auth code provide window.GEMAuth.getSession()
   * (sync or async, returning the shape above), or by replacing the body of AuthAdapter.getSession().
   * Nothing here stores, copies or hard-codes a token: it is asked for again before every request. */
  const AuthAdapter = {
    async getSession() {
      const provider = window.GEMAuth;
      if (!provider || typeof provider.getSession !== 'function') return null;   // not connected yet = signed out
      try { return await provider.getSession(); } catch (_) { return null; }
    }
  };
  /** Temporary Guest Mode (js/guest-auth.js sets window.GEMAuth.isGuest). A real login provider does not set it, so with a real
   *  login the normal "sign in" texts are used. In Guest Mode the visitor is never asked to sign in or register. */
  const guestMode = () => CONFIG.mode === 'api' && Boolean(window.GEMAuth && window.GEMAuth.isGuest === true);
  /** Accepts only a complete, unexpired session (30 s safety margin). Anything else counts as signed out. */
  function usableSession(session) {
    if (!session || !session.user || typeof session.user.id !== 'string' || !session.user.id) return null;
    if (typeof session.accessToken !== 'string' || !session.accessToken) return null;
    if (Number.isFinite(session.expiresAt) && session.expiresAt * 1000 <= Date.now() + 30000) return null;
    return session;
  }
  /** Sandbox mock only (?mode=mock). Never used in API mode. */
  const DEMO_USER = { id: 'demo-user-001', name: 'Demo visitor' };
  const OTHER_USER = { id: 'demo-user-999', name: 'Another visitor' };   // exists only to prove isolation
  const MockAuthService = {
    getSession() { return { user: DEMO_USER, accessToken: null }; }
  };

  /* ---- 5b. Bookings ----
   * Real backend (API mode):
   *   GET /api/bookings  -> { data: { bookings: [ { id, booking_reference, visitor_name, visit_date, ticket_count, status, created_at } ] } }
   *                         for the signed-in visitor only.
   * Bookings are NEVER created from here: the backend creates them inside POST /api/ai/chat (section 5c),
   * so there is deliberately no create() in ApiBookingService, and POST /api/bookings is never called.
   * The mock below (sandbox only) keeps its own create() so the sandbox flow still works. */
  const readCreated = () => { try { return JSON.parse(store.get(CONFIG.storage.bookings) || '[]'); } catch (_) { return []; } };
  const writeCreated = (rows) => store.set(CONFIG.storage.bookings, JSON.stringify(rows));
  /** Seed data is generated relative to "now" so no dates are hard-coded. */
  function seedBookings() {
    const now = Date.now(), today = todayISO();
    const row = (id, user, visitOffset, count, status, createdDaysAgo) => ({ id, user_id: user.id, visit_date: addDays(today, visitOffset), ticket_count: count, status, created_at: new Date(now - createdDaysAgo * 86400000).toISOString() });
    return [
      row('7c1f3a90-2b4d-4e8a-9a61-5d2e0b7f1c01', DEMO_USER, 3, 2, 'demo_pending', 1),
      row('b94e12d7-6c3a-41f0-8e25-0a9d4c6e7f02', DEMO_USER, 12, 4, 'demo_pending', 4),
      row('e05a7b38-91cd-4d62-b7f4-3c18a2d90e03', DEMO_USER, -9, 1, 'demo_cancelled', 15),
      row('1d8c4f26-a7e3-4b59-8c10-9e6f2b3a5d04', DEMO_USER, -25, 3, 'demo_pending', 31),
      row('f3a9e6c1-5b02-4d7e-a8c4-6b1d0e9f7a05', OTHER_USER, 5, 6, 'demo_pending', 2),
      row('2e6b8d04-c9f1-4a35-b7d2-8a4c1e5f3b06', OTHER_USER, 20, 2, 'demo_pending', 6)
    ];
  }
  const MockBookingService = {
    /** @param {{visit_date:string, ticket_count:number, idempotency_key:string}} payload */
    async create(payload, session) {
      await wait(CONFIG.latency.booking);
      if (!session) throw apiError('UNAUTHENTICATED');
      // The backend must validate again; never trust the browser.
      if (!validateDate(payload.visit_date).ok || !validateVisitors(payload.ticket_count).ok) throw apiError('VALIDATION_ERROR');
      if (mockOptions.failBooking) { mockOptions.failBooking = false; throw apiError('MOCK_BOOKING_FAILED'); }
      const rows = readCreated();
      const duplicate = rows.find((r) => r.user_id === session.user.id && r.idempotency_key === payload.idempotency_key);
      if (duplicate) return duplicate;   // same confirmation sent twice: return the first result
      const record = { id: uuid(), user_id: session.user.id, visit_date: payload.visit_date, ticket_count: payload.ticket_count, status: 'demo_pending', created_at: new Date().toISOString(), idempotency_key: payload.idempotency_key };
      rows.push(record);
      writeCreated(rows);
      return record;
    },
    async listMine(session) {
      await wait(mockOptions.historyMode === 'slow' ? CONFIG.latency.historySlow : CONFIG.latency.history);
      if (!session) throw apiError('UNAUTHENTICATED');
      if (mockOptions.historyMode === 'error') throw apiError('MOCK_HISTORY_FAILED');
      const all = [...(mockOptions.historyMode === 'empty' ? [] : seedBookings()), ...readCreated()];
      return all.filter((r) => r.user_id === session.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    reset() { store.remove(CONFIG.storage.bookings); }
  };
  /** One booking row from the backend, checked and cleaned. Returns null when it is not a usable booking. */
  function readBooking(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id || typeof raw.booking_reference !== 'string' || !raw.booking_reference) return null;
    return {
      id: String(raw.id), booking_reference: raw.booking_reference,
      visitor_name: typeof raw.visitor_name === 'string' ? raw.visitor_name : null,
      visit_date: String(raw.visit_date || ''), ticket_count: Number(raw.ticket_count),
      status: String(raw.status || 'confirmed'),
      created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
      replayed: raw.replayed === true
    };
  }
  /** INTEGRATION: talks to our backend. Reading only: see the note in 5b. */
  const ApiBookingService = {
    async listMine(session) {
      const data = await requestJson(CONFIG.api.bookings, { token: session && session.accessToken });
      if (!data || !Array.isArray(data.bookings)) throw apiError('BAD_RESPONSE');
      return data.bookings.map(readBooking).filter(Boolean);
    },
    reset() {}
  };

  /* ---- 5c. Chat ----
   * Real backend: POST /api/ai/chat   (Authorization: Bearer <access token>)
   *   body    { message, conversation_id, language: 'en'|'ar', confirmation_revision? }
   *   answer  { data: { reply, language, extracted: { visit_date, ticket_count, visitor_name }, action: null|'confirm'|'reset'|'cancel_booking'|'modify_booking',
   *                     draft_saved, confirmation_revision, new_conversation_required?, booking?,
   *                     planner_status?, plan?, plan_pending? } }   (the planner fields are only present when the planner took part)
   * - The backend keeps the booking draft (date, visitors, name) and a revision number for it. confirmation_revision says
   *   "this is the summary I just showed you". It is sent back with the confirmation, and the backend rejects an outdated one.
   * - A confirmation is a chat message ("Yes confirm") plus the latest revision. On success the answer has action 'confirm'
   *   and booking { id, booking_reference, visitor_name, visit_date, ticket_count, status, replayed }.
   * - conversation_id stays the same for one booking conversation and is renewed when the backend asks for it
   *   (new_conversation_required) or on "Start over". The user id is never sent: the backend takes it from the token. */
  const MockChatService = {
    async sendMessage(payload) {
      await wait(rand(CONFIG.latency.chatMin, CONFIG.latency.chatMax));
      if (mockOptions.failChat) { mockOptions.failChat = false; throw apiError('MOCK_CHAT_FAILED'); }
      return runMockAgent(payload);
    }
  };
  const ApiChatService = {
    async sendMessage(payload, session) {
      const body = { message: payload.message, conversation_id: payload.conversationId, language: payload.chatLanguage };
      // Always the LATEST revision the backend gave us (or none). The backend rejects it unless it is still the presented one.
      if (Number.isSafeInteger(payload.confirmationRevision) && payload.confirmationRevision >= 1) body.confirmation_revision = payload.confirmationRevision;
      const data = await requestJson(CONFIG.api.chat, { method: 'POST', token: session && session.accessToken, body });
      return readChatAnswer(data, payload);
    }
  };

  /** planner_status values the backend can send (backend/planner-client.js). Anything else is ignored. */
  const PLANNER_STATUSES = ['plan_created', 'plan_updated', 'needs_clarification', 'not_possible', 'handoff', 'out_of_scope', 'not_planning', 'smalltalk', 'unavailable'];

  /** The AI is not trusted to answer in a perfect shape. Check it and fill the gaps, so the page never breaks. */
  function readChatAnswer(data, payload) {
    const action = data && (data.action === 'confirm' || data.action === 'reset' || data.action === 'cancel_booking' || data.action === 'modify_booking') ? data.action : null;
    if (!data || typeof data.reply !== 'string' || (data.reply.trim() === '' && !action)) throw apiError('BAD_RESPONSE');
    // The rule-based backend sends the COMPLETE stored draft every time. A null therefore means "not set (any more)",
    // for example after "change the name". Keys that are missing altogether are left alone.
    const found = data.extracted || {};
    const extracted = {};
    if ('visit_date' in found) extracted.visit_date = found.visit_date ? String(found.visit_date) : null;
    if ('ticket_count' in found) extracted.ticket_count = found.ticket_count === null || found.ticket_count === undefined || found.ticket_count === '' ? null : Number(found.ticket_count);
    if ('visitor_name' in found) extracted.visitor_name = typeof found.visitor_name === 'string' && found.visitor_name.trim() ? found.visitor_name.trim() : null;
    // A cancelled or modified booking is never shown as a NEW confirmed one: each travels in its own field.
    const booking = action === 'cancel_booking' || action === 'modify_booking' ? null : readBooking(data.booking);
    const cancelled = action === 'cancel_booking' ? readBooking(data.booking) : null;
    const modified = action === 'modify_booking' ? readBooking(data.booking) : null;
    if (action === 'confirm' && !booking) throw apiError('BAD_RESPONSE');       // a confirmation without a real booking is never shown as success
    const revision = Number.isSafeInteger(data.confirmation_revision) && data.confirmation_revision >= 1 ? data.confirmation_revision : null;
    const lang = data.language === 'ar' || data.language === 'en' ? data.language : detectLang(data.reply, payload.chatLanguage);
    // Smart Visit Planner fields (all optional; absent when the planner took no part). Only known values are kept.
    const plannerStatus = PLANNER_STATUSES.includes(data.planner_status) ? data.planner_status : null;
    const plan = data.plan && typeof data.plan === 'object' && !Array.isArray(data.plan) ? data.plan : null;
    return {
      lang, reply: data.reply, extracted, action, booking, cancelled, modified, confirmationRevision: revision,
      newConversationRequired: data.new_conversation_required === true,
      plannerStatus, plan, planPending: data.plan_pending === true, demo: data.demo === true
    };
    // applyExtracted() validates the dates and numbers again
  }

  const Services = CONFIG.mode === 'api'
    ? { auth: AuthAdapter, booking: ApiBookingService, chat: ApiChatService }
    : { auth: MockAuthService, booking: MockBookingService, chat: MockChatService };

  /* ======================================================================
   * === 6. STATE
   * ==================================================================== */
  const state = {
    uiLang: 'en',
    chatLang: 'en',
    draft: { visitDate: null, visitors: null, visitorName: null },
    confirmationRevision: null,                 // API mode: the summary revision the backend last presented (null = nothing to confirm)
    planPending: false,                         // API mode: a visit plan the visitor asked for is not finished (the backend holds the booking summary)
    plannerStatus: null,                        // API mode: planner_status of the last answer (null = the planner took no part)
    errors: { date: null, visitors: null },     // error codes, localised at render time
    failed: false,
    confirmed: null,                            // booking row after a successful confirmation
    confirming: false,
    busy: false,                                // assistant is replying
    draftId: uuid(),                            // sandbox mock only (idempotency key of the mock booking)
    conversationId: uuid(),                     // the AI's conversation id; kept for one booking, new one on "Start over" / reset
    messages: [],
    session: null,                              // last session from the AuthAdapter (never stored anywhere else)
    authRequired: false,                        // API mode and nobody signed in
    alert: null,                                // { key, retry } of the message in the chat alert box
    lastFailedMessage: null,
    history: { status: 'loading', items: [], showAll: false, token: 0, justAddedId: null }
  };
  /** Ready to confirm. The real backend also needs the visitor's name and the revision it presented; the sandbox mock does not. */
  const draftValid = () => isDraftValid(state.draft)
    && (CONFIG.mode === 'mock' || (isValidVisitorName(state.draft.visitorName) && state.confirmationRevision !== null));
  /** What the page is waiting for next: both | date | visitors | name | review | confirm. */
  function pendingAsk() {
    if (CONFIG.mode === 'api' && state.planPending) return state.plannerStatus === 'unavailable' ? 'planDown' : 'plan';   // the backend finishes the plan first
    const base = pendingAskFor(state.draft);
    if (base !== 'confirm' || CONFIG.mode === 'mock') return base;
    if (!isValidVisitorName(state.draft.visitorName)) return 'name';
    return state.confirmationRevision === null ? 'review' : 'confirm';
  }
  const planJustShown = () => CONFIG.mode === 'api' && ['plan_created', 'plan_updated'].includes(state.plannerStatus);
  const chipsFor = (ask) => (CONFIG.mode === 'api' && ask === 'confirm'
    ? [CONFIRM_PHRASE[state.chatLang], CHIPS[state.chatLang].confirm[1]]
    : ask === 'both' && planJustShown() ? CHIPS[state.chatLang].planned
    : CHIPS[state.chatLang][ask] || []);
  function currentStatus() {
    if (state.confirmed) return 'confirmed';
    if (state.failed && draftValid()) return 'failed';
    return draftValid() ? 'awaiting' : 'draft';
  }
  const t = () => UI[state.uiLang];

  /* ======================================================================
   * === 7. RENDERING  (DOM built with textContent only)
   * ==================================================================== */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** Egyxos's chat avatar: a face crop of the same illustration (assets/egyxos-avatar.webp). One static image. */
  const ASSISTANT_NAME = 'Egyxos';
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
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const ui = {
    log: $('#chat-log'), empty: $('#chat-empty'), messages: $('#chat-messages'), emptyChips: $('#empty-chips'), chips: $('#chat-chips'),
    form: $('#chat-form'), input: $('#chat-input'), send: $('#chat-send'), alert: $('#chat-alert'), alertText: $('#chat-alert-text'),
    alertRetry: $('#chat-alert-retry'), reset: $('#chat-reset'),
    summary: $('#summary'), rowName: $('#row-name'), name: $('#sum-name'), date: $('#sum-date'), dateError: $('#sum-date-error'), visitors: $('#sum-visitors'), visitorsError: $('#sum-visitors-error'),
    status: $('#sum-status'), rowRef: $('#row-ref'), ref: $('#sum-ref'), hint: $('#sum-hint'), confirm: $('#confirm-btn'), confirmLabel: $('#confirm-label'),
    stamp: $('#demo-stamp'), newBooking: $('#new-booking-btn'),
    historyBody: $('#history-body'), viewAll: $('#history-viewall')
  };

  /* ---- chat ---- */
  function addMessage({ role, text, lang }) {
    const now = new Date();
    state.messages.push({ role, text, lang, at: now.toISOString() });
    const isUser = role === 'user';
    const wrap = el('div', `msg msg--${isUser ? 'user' : 'ai'}`);
    const avatar = isUser ? el('span', 'avatar avatar--user') : egyxosAvatar();
    if (isUser) { avatar.setAttribute('aria-hidden', 'true'); avatar.append(icon('user')); }
    const main = el('div', 'msg__main');
    const bubble = el('div', 'msg__bubble', text);   // textContent: never HTML
    bubble.lang = lang;
    bubble.dir = 'auto';
    const time = el('time', 'msg__time', formatTime(now, lang));
    time.dateTime = now.toISOString();
    // Egyxos's name is visible on every one of his messages; visitor messages get a screen-reader label.
    main.append(isUser ? el('span', 'sr', t().roleUser) : el('span', 'msg__name', ASSISTANT_NAME), bubble, time);
    wrap.append(avatar, main);
    ui.messages.append(wrap);
    scrollLog();
    renderChips();
  }
  function showTyping() {
    if ($('.msg--typing', ui.messages)) return;
    const wrap = el('div', 'msg msg--ai msg--typing');
    wrap.setAttribute('role', 'status');
    const bubble = el('div', 'msg__bubble');
    bubble.append(el('span', 'typing-dot'), el('span', 'typing-dot'), el('span', 'typing-dot'), el('span', 'sr', t().typing));
    const main = el('div', 'msg__main'); main.append(bubble);
    wrap.append(egyxosAvatar(), main);
    ui.messages.append(wrap);
    scrollLog();
  }
  const hideTyping = () => { const node = $('.msg--typing', ui.messages); if (node) node.remove(); };
  function scrollLog() { ui.log.scrollTo({ top: ui.log.scrollHeight, behavior: motionReduced ? 'auto' : 'smooth' }); }

  function makeChip(label, onClick) {
    const btn = el('button', 'chip', label);
    btn.type = 'button';
    btn.addEventListener('click', () => onClick(label));
    return btn;
  }
  function renderChips() {
    const empty = state.messages.length === 0;
    ui.empty.hidden = !empty;
    ui.emptyChips.replaceChildren(...EMPTY_CHIPS.map((label) => { const chip = makeChip(label, (text) => sendMessage(text)); chip.lang = /[؀-ۿ]/.test(label) ? 'ar' : 'en'; return chip; }));
    const set = !empty && !state.confirmed ? chipsFor(pendingAsk()) : [];
    ui.chips.hidden = set.length === 0;
    if (set.length === 0) { ui.chips.replaceChildren(); return; }
    ui.chips.replaceChildren(...set.map((label) => { const chip = makeChip(label, (text) => sendMessage(text)); chip.lang = state.chatLang; chip.disabled = state.busy || state.confirming; return chip; }));
  }
  /** key = a text in UI (so the alert follows the language switch). retry = show the "Try again" button. */
  function showAlert(key, retry = true) { state.alert = { key, retry }; renderAlert(); }
  const hideAlert = () => { state.alert = null; renderAlert(); };
  function renderAlert() {
    const a = state.alert;
    ui.alert.hidden = !a;
    if (!a) return;
    ui.alertText.textContent = t()[a.key];
    ui.alertRetry.hidden = !a.retry;
  }
  function setBusyUI() {
    const locked = state.busy || state.confirming;
    ui.input.disabled = locked;
    ui.log.setAttribute('aria-busy', String(locked));
    ui.reset.disabled = locked;
    updateSendEnabled();
  }
  const updateSendEnabled = () => { ui.send.disabled = state.busy || state.confirming || ui.input.value.trim() === ''; };

  /* ---- summary ---- */
  function setValue(node, text, isEmpty) { node.textContent = text; node.classList.toggle('is-empty', isEmpty); }
  function renderSummary() {
    showSummaryValues();
    showSummaryStatus();
    showConfirmButton();
    setBusyUI();
  }
  /** Date, visitors and their error messages. */
  function showSummaryValues() {
    const tr = t(), d = state.draft;
    ui.rowName.hidden = CONFIG.mode !== 'api';       // the sandbox mock does not ask for a name
    setValue(ui.name, d.visitorName || tr.notSet, !d.visitorName);
    setValue(ui.date, d.visitDate ? formatDate(d.visitDate, state.uiLang) : tr.notSet, !d.visitDate);
    setValue(ui.visitors, d.visitors !== null ? tr.visitorsValue(d.visitors) : tr.notSet, d.visitors === null);
    for (const [key, node] of [['date', ui.dateError], ['visitors', ui.visitorsError]]) {
      const code = state.errors[key];
      node.hidden = !code;
      node.textContent = code ? tr.err[key][code] : '';
    }
  }
  /** Status badge, booking reference and the hint under the summary. */
  function showSummaryStatus() {
    const tr = t(), status = currentStatus();
    ui.status.textContent = tr.status[status];
    ui.status.dataset.status = status;
    ui.rowRef.hidden = !state.confirmed;
    ui.ref.textContent = state.confirmed ? bookingReference(state.confirmed) : '';
    ui.summary.classList.toggle('is-confirmed', status === 'confirmed');

    // The hint explains why the button is enabled or disabled (aria-describedby on the button).
    let hint;
    if (status === 'confirmed') hint = tr.hint.confirmed;
    else if (status === 'failed') hint = tr.hint.failed;
    else if (status === 'awaiting') hint = tr.hint.ready;
    else if (state.authRequired) hint = guestMode() ? tr.hint.guest : tr.hint.signIn;
    else if (state.errors.date || state.errors.visitors) hint = tr.hint.invalid;
    else hint = tr.hint[pendingAsk()];
    ui.hint.textContent = hint;
  }
  /** Confirm button, demo stamp and "Start a new booking" button. */
  function showConfirmButton() {
    const tr = t(), status = currentStatus();
    const canConfirm = (status === 'awaiting' || status === 'failed') && !state.confirming && !state.busy;
    ui.confirm.hidden = status === 'confirmed';
    ui.confirm.disabled = !canConfirm;
    ui.confirm.classList.toggle('is-loading', state.confirming);
    ui.confirm.setAttribute('aria-busy', String(state.confirming));
    ui.confirmLabel.textContent = state.confirming ? tr.confirming : status === 'failed' ? tr.retryBtn : tr.confirmBtn;
    ui.stamp.hidden = status !== 'confirmed';
    ui.newBooking.hidden = status !== 'confirmed';
  }

  /* ---- history ---- */
  function panel({ iconName, title, text, action, tone }) {
    const box = el('div', `state-panel${tone ? ` state-panel--${tone}` : ''}`);
    const ic = el('span', 'state-panel__icon'); ic.append(icon(iconName));
    box.append(ic, el('h3', '', title), el('p', '', text));
    if (action) {
      const btn = action.href ? el('a', 'btn btn--ink', action.label) : el('button', 'btn btn--ink', action.label);
      if (action.href) btn.href = action.href; else { btn.type = 'button'; btn.addEventListener('click', action.onClick); }
      box.append(btn);
    }
    return box;
  }
  function bookingCard(row) {
    const lang = state.uiLang, tr = t();
    const li = el('li', `booking-card${row.id === state.history.justAddedId ? ' is-new' : ''}`);
    const top = el('div', 'booking-card__top');
    const statusKey = row.status === 'demo_cancelled' || row.status === 'cancelled' ? 'cancelled' : 'confirmed';   // the backend's 'confirmed' and the mock's 'demo_pending' both show as "Confirmed"
    const badge = el('span', 'status-badge', tr.status[statusKey]);
    badge.dataset.status = statusKey;
    // Label + badge share a row so the long date below gets the card's full width.
    top.append(el('span', 'booking-card__label', tr.cardVisitDate), badge);
    const date = el('div', 'booking-card__date', formatDate(row.visit_date, lang));
    const meta = el('dl', 'booking-card__meta');
    const refValue = el('dd', 'booking-card__ref', bookingReference(row));
    refValue.dir = 'ltr';
    meta.append(el('dt', '', tr.cardVisitors), el('dd', '', tr.visitorsValue(row.ticket_count)), el('dt', '', tr.cardRef), refValue);
    li.append(top, date, meta, el('p', 'booking-card__foot', `${tr.cardCreated}: ${formatDateTime(row.created_at, lang)}`));
    return li;
  }
  function renderHistory() {
    const h = state.history, tr = t();
    ui.historyBody.setAttribute('aria-busy', String(h.status === 'loading'));
    ui.historyBody.replaceChildren();
    const canExpand = h.status === 'ready' && h.items.length > 3;
    ui.viewAll.hidden = !canExpand;
    ui.viewAll.textContent = h.showAll ? tr.showFewer : tr.viewAll(h.items.length);
    ui.viewAll.setAttribute('aria-expanded', String(h.showAll));

    if (h.status === 'loading') {
      const grid = el('ul', 'booking-grid'); grid.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) {
        const card = el('li', 'booking-card booking-card--skeleton');
        for (const width of ['55%', '35%', '80%', '60%']) { const bar = el('span', 'skel'); bar.style.height = '14px'; bar.style.width = width; card.append(bar); }
        grid.append(card);
      }
      ui.historyBody.append(el('p', 'sr', tr.histLoading), grid);
    } else if (h.status === 'signin') {
      ui.historyBody.append(panel({ iconName: 'user', title: guestMode() ? tr.histGuestTitle : tr.histSignInTitle, text: guestMode() ? tr.histGuestText : tr.histSignInText, action: { label: tr.retry, onClick: loadHistory } }));
    } else if (h.status === 'error') {
      ui.historyBody.append(panel({ iconName: 'alert', title: tr.histErrorTitle, text: tr.histErrorText, tone: 'error', action: { label: tr.retry, onClick: loadHistory } }));
    } else if (h.status === 'empty') {
      ui.historyBody.append(panel({ iconName: 'list', title: tr.histEmptyTitle, text: tr.histEmptyText, action: { label: tr.histEmptyBtn, href: '#chat' } }));
    } else {
      const grid = el('ul', 'booking-grid');
      (h.showAll ? h.items : h.items.slice(0, 3)).forEach((row) => grid.append(bookingCard(row)));
      ui.historyBody.append(grid);
    }
  }

  /* ======================================================================
   * === 8. CONTROLLERS
   * ==================================================================== */
  function resetDraft() {
    state.draft = { visitDate: null, visitors: null, visitorName: null };
    state.confirmationRevision = null;
    state.planPending = false;
    state.plannerStatus = null;
    state.errors = { date: null, visitors: null };
    state.failed = false;
    state.confirmed = null;
    state.draftId = uuid();
  }

  /** Apply the agent's raw extraction through OUR validators (single source of truth). */
  function applyExtracted(extracted) {
    if ('visit_date' in extracted) {
      const check = extracted.visit_date === null ? { ok: false, code: null } : validateDate(extracted.visit_date);
      state.draft.visitDate = check.ok ? extracted.visit_date : null;
      state.errors.date = check.ok ? null : check.code;
      state.failed = false;
    }
    if ('ticket_count' in extracted) {
      const check = extracted.ticket_count === null ? { ok: false, code: null } : validateVisitors(extracted.ticket_count);
      state.draft.visitors = check.ok ? extracted.ticket_count : null;
      state.errors.visitors = check.ok ? null : check.code;
      state.failed = false;
    }
    if ('visitor_name' in extracted) {
      state.draft.visitorName = isValidVisitorName(extracted.visitor_name) ? extracted.visitor_name.trim() : null;
      state.failed = false;
    }
  }

  /** The session the AuthAdapter gives us right now (a fresh look every time, nothing is cached).
   *  API mode accepts only a complete, unexpired session; otherwise it returns null and nothing may be sent. */
  async function getSession() {
    const raw = await Services.auth.getSession();
    state.session = CONFIG.mode === 'api' ? usableSession(raw) : raw;
    state.authRequired = CONFIG.mode === 'api' && !state.session;
    return state.session;
  }
  /** Signed out. There is NO red banner: the hint under the summary says "Sign in…", and when the visitor tries to chat,
   *  Egyxos answers once with the same sentence as a normal chat message. Login/Register belong to another page; this page only
   *  asks the shared session (AuthAdapter / window.GEMAuth) again before every message, so it works as soon as the visitor is signed in. */
  function showAuthRequired({ say = false } = {}) {
    state.authRequired = true;
    if (say) {
      const text = guestMode() ? t().guestNotReady : t().authRequired, last = state.messages[state.messages.length - 1];
      if (!last || last.text !== text) addMessage({ role: 'ai', text, lang: state.uiLang });
    }
    renderSummary();
    renderChips();
  }
  const isAuthError = (error) => Boolean(error) && (error.status === 401 || error.code === 'UNAUTHORIZED' || error.code === 'UNAUTHENTICATED');
  /** Which visitor-facing text (a key in UI) explains this error. The page never shows server text. */
  function errorKey(error) {
    const code = error && error.code;
    if (isAuthError(error)) return guestMode() ? 'guestExpired' : 'sessionExpired';
    if (code === 'TIMEOUT') return 'errTimeout';
    if (code === 'NETWORK_ERROR') return 'errNetwork';
    if (['BOOKING_REVISION_NOT_PRESENTED', 'BOOKING_DRAFT_CHANGED', 'CONFIRMATION_REVISION_REQUIRED', 'BOOKING_DETAILS_MISMATCH'].includes(code)) return 'errStale';
    if (['VISITOR_NAME_REQUIRED', 'BOOKING_DETAILS_INCOMPLETE'].includes(code)) return 'errNeedName';
    if (['BOOKING_DRAFT_NOT_FOUND', 'BOOKING_DRAFT_NOT_ACTIVE', 'NO_ACTIVE_DRAFT_TO_CANCEL'].includes(code)) return 'errDraftGone';
    if (['INVALID_VISIT_DATE', 'INVALID_VISITOR_COUNT', 'INVALID_BOOKING_DETAILS'].includes(code)) return 'errInvalid';
    return 'chatError';
  }
  /** Errors where trying the same request again makes sense. The others need the visitor to change something first. */
  const retryable = (key) => ['chatError', 'errTimeout', 'errNetwork', 'sessionExpired', 'guestExpired'].includes(key);

  /** A booking the backend (or the sandbox mock) created: show it as confirmed and update the history. */
  function showConfirmed(booking) {
    state.confirmed = booking;
    state.failed = false;
    state.confirmationRevision = null;
    if (CONFIG.mode === 'api') { refreshHistoryAfterBooking(booking); return; }
    state.history.items = [booking, ...state.history.items.filter((row) => row.id !== booking.id)];
    state.history.status = 'ready';
    state.history.justAddedId = booking.id;
    renderHistory();
  }
  /** Brief: refresh My Bookings from GET /api/bookings. If that call fails the new booking is still shown. */
  async function refreshHistoryAfterBooking(booking) {
    const token = ++state.history.token;
    let items;
    try {
      items = await Services.booking.listMine(await getSession());
      if (!items.some((row) => row.id === booking.id)) items = [booking, ...items];
    } catch (_) {
      items = [booking, ...state.history.items.filter((row) => row.id !== booking.id)];
    }
    if (token !== state.history.token) return;
    state.history.items = items;
    state.history.status = 'ready';
    state.history.justAddedId = booking.id;
    renderHistory();
  }

  /** Use the backend's answer: language, extracted values (validated again here), the revision, reply text, a created booking. */
  function applyChatResult(result, { ourConfirm = false } = {}) {
    state.chatLang = result.lang;
    if (result.action === 'reset') {
      resetDraft();
      if (result.newConversationRequired) state.conversationId = uuid();   // the backend closed this conversation's draft
    } else {
      applyExtracted(result.extracted || {});
      if (result.newConversationRequired) state.conversationId = uuid();   // safety net: the backend closed this conversation
    }
    if (CONFIG.mode === 'api') {
      // The backend sends the revision it just presented. Without one nothing is presented, so the old revision is dropped.
      // Exception: our own "confirm" message that was not carried out. The backend still presents the same summary then.
      if (result.confirmationRevision !== null && result.confirmationRevision !== undefined) state.confirmationRevision = result.confirmationRevision;
      else if (!ourConfirm || result.booking || result.action === 'reset') state.confirmationRevision = null;
      // Visit plan: the backend says "plan_pending" while a requested plan is unfinished. It then shows no booking summary.
      // Every answer replaces the last one, so a plain booking answer clears it. A reset or a created booking clears it too.
      state.planPending = result.planPending === true && !result.booking && result.action !== 'reset';
      state.plannerStatus = result.plannerStatus;
    }
    if (result.reply) addMessage({ role: 'ai', text: result.reply, lang: result.lang });
    if (result.booking) showConfirmed(result.booking);
    if (result.cancelled) onBookingCancelled(result.cancelled);
    if (result.action === 'modify_booking') onBookingModified();
    renderSummary();
  }

  /** A booking was changed through the chat (the backend did it, after an explicit yes). It is the SAME booking: same id,
   *  same reference, still confirmed. Nothing is created and the draft on screen is left alone. Refresh My Bookings. */
  function onBookingModified() {
    if (CONFIG.mode === 'api') loadHistory({ silent: true });
  }

  /** A booking was cancelled through the chat (the backend did it, after an explicit yes).
   *  If it is the one on screen, leave the "confirmed" view. Then refresh My Bookings: the row shows "Cancelled". */
  function onBookingCancelled(booking) {
    if (state.confirmed && state.confirmed.booking_reference === booking.booking_reference) { resetDraft(); state.conversationId = uuid(); }
    if (CONFIG.mode === 'api') loadHistory({ silent: true });
  }

  /** Sends one visitor message to the assistant and shows the answer.
   *  confirming = true when it is the Confirm button (the message is the confirm phrase). */
  async function sendMessage(text, { retry = false, confirming = false } = {}) {
    const message = String(text || '').trim().slice(0, CONFIG.maxMessageLength);
    if (!message || state.busy || state.confirming) return;
    if (confirming) state.confirming = true; else state.busy = true;   // locked synchronously, before any await
    state.failed = false;
    hideAlert();
    let typing = false;
    try {
      // 0. API mode: no valid session = no request. The typed text stays in the box.
      const session = await getSession();
      if (!session) { showAuthRequired({ say: true }); return; }
      // A finished booking closes its conversation on the backend. A visitor who keeps typing is starting a NEW booking.
      if (CONFIG.mode === 'api' && state.confirmed && !retry && !confirming) { resetDraft(); state.conversationId = uuid(); }
      if (!retry) {
        // 1. Show the visitor's message. Egyxos opens the conversation first.
        const messageLang = detectLang(message, state.uiLang);
        const mockWillGreet = CONFIG.mode === 'mock' && isGreeting(message);   // MOCK ONLY: the mock says hello itself
        if (state.messages.length === 0 && !mockWillGreet) addMessage({ role: 'ai', text: UI[messageLang].emptyIntro, lang: messageLang });
        addMessage({ role: 'user', text: message, lang: detectLang(message, state.chatLang) });
      }
      ui.input.value = '';
      renderSummary();
      showTyping();                                                    // 2. Typing dots while we wait
      typing = true;
      // 3. Ask the assistant (the real backend, or the sandbox mock)
      const ourConfirm = Object.values(CONFIRM_PHRASE).some((phrase) => phrase.toLowerCase() === message.toLowerCase());
      const result = await Services.chat.sendMessage({
        message, draft: { ...state.draft }, status: currentStatus(), reference: state.confirmed ? bookingReference(state.confirmed) : null,
        conversationId: state.conversationId, confirmationRevision: state.confirmationRevision, uiLanguage: state.uiLang, chatLanguage: state.chatLang
      }, session);
      hideTyping(); typing = false;
      // 4. Use the answer
      applyChatResult(result, { ourConfirm });
      if (result.action === 'confirm' && !result.booking) await confirmBooking({ lang: result.lang });   // sandbox mock only: the real backend always sends the booking
    } catch (error) {
      if (typing) hideTyping();                                        // the visitor can press "Try again"
      const key = errorKey(error);
      if (['errStale', 'errNeedName', 'errDraftGone'].includes(key)) state.confirmationRevision = null;   // the summary is no longer valid
      if (isAuthError(error)) state.authRequired = true;
      state.lastFailedMessage = message;
      if (confirming) state.failed = ['chatError', 'errTimeout', 'errNetwork'].includes(key);
      showAlert(key, retryable(key) && !confirming);
      if (key === 'errTimeout' && CONFIG.mode === 'api') loadHistory({ silent: true });   // the booking may have been created before the answer was lost
    } finally {
      // 5. finally runs after success AND after an error: unlock the page and redraw
      state.busy = false;
      state.confirming = false;
      renderSummary();
      renderChips();
      if (state.confirmed) ui.newBooking.focus({ preventScroll: true });
      else if (!ui.input.disabled) ui.input.focus({ preventScroll: true });
    }
  }

  /** Explicit confirmation (the Confirm button). API mode: it is a chat message plus the latest revision, because the backend
   *  creates the booking inside POST /api/ai/chat. A repeated click is ignored while one is running or after success. */
  async function confirmBooking({ lang } = {}) {
    if (state.confirming || state.confirmed) return;                 // blocks duplicate clicks / repeated "yes"
    if (!draftValid()) { renderSummary(); return; }                  // never confirm unvalidated data
    if (CONFIG.mode === 'api') return sendMessage(CONFIRM_PHRASE[lang || state.chatLang], { confirming: true });
    const language = lang || state.chatLang;
    const R = REPLIES[language];
    state.confirming = true;                                         // set synchronously, before any await
    state.failed = false;
    renderSummary();
    showTyping();
    try {
      const booking = await Services.booking.create({
        visit_date: state.draft.visitDate,
        ticket_count: state.draft.visitors,
        idempotency_key: `${state.draftId}:${state.draft.visitDate}:${state.draft.visitors}`
      }, await getSession());
      hideTyping();
      showConfirmed(booking);                                        // "Confirmed" only after the service succeeded
      addMessage({ role: 'ai', text: R.success(bookingReference(booking)), lang: language });
    } catch (error) {
      hideTyping();
      state.failed = true;
      addMessage({ role: 'ai', text: error.code === 'DUPLICATE_BOOKING' ? R.duplicate : R.failure, lang: language });
    } finally {
      state.confirming = false;
      renderSummary();
      renderChips();
      (state.confirmed ? ui.newBooking : ui.confirm).focus({ preventScroll: true });
    }
  }

  function resetConversation() {
    if (state.busy || state.confirming) return;
    resetDraft();
    state.messages = [];
    state.conversationId = uuid();                                   // the AI starts a fresh memory
    state.chatLang = state.uiLang;
    ui.messages.replaceChildren();
    hideAlert();
    renderSummary();
    renderChips();
    ui.input.focus({ preventScroll: true });
  }

  /* ---- history loading ----
   * silent = refresh in the background: keep what is shown and ignore errors (used after a confirmation). */
  async function loadHistory({ silent = false } = {}) {
    const token = ++state.history.token;
    if (!silent) {
      state.history.showAll = false;
      state.history.status = 'loading';
      renderHistory();
    }
    try {
      const session = await getSession();
      if (token !== state.history.token) return;                     // a newer load replaced this one
      if (!session) { if (!silent) { state.history.status = 'signin'; renderHistory(); } return; }
      const items = await Services.booking.listMine(session);
      if (token !== state.history.token) return;
      state.history.items = items;
      state.history.status = items.length ? 'ready' : 'empty';
    } catch (error) {
      if (token !== state.history.token || silent) return;
      state.history.status = isAuthError(error) ? 'signin' : 'error';
    }
    renderHistory();
  }

  /* ======================================================================
   * === 9. SHELL + INIT
   * The homepage's behaviour lives in js/app.js, which is homepage-only, so the
   * few pieces this page needs (sticky header, menu, language) are repeated here.
   * ==================================================================== */
  const header = $('#site-header');
  const menuToggle = $('#menu-toggle');
  const langToggle = $('#lang-toggle');

  function setMenuOpen(isOpen) {
    header.classList.toggle('is-menu-open', isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', t()[isOpen ? 'menuClose' : 'menuOpen']);
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
    langToggle.textContent = t().langButton;
    langToggle.setAttribute('aria-label', t().langLabel);
    menuToggle.setAttribute('aria-label', t()[header.classList.contains('is-menu-open') ? 'menuClose' : 'menuOpen']);
    document.title = t().pageTitle;
    if (state.messages.length === 0) state.chatLang = lang;
    renderSummary();
    renderChips();
    renderHistory();
    store.set(CONFIG.storage.language, lang);
    renderAlert();                                                   // a shown message follows the language switch
  }

  function bindEvents() {
    langToggle.addEventListener('click', () => setLanguage(state.uiLang === 'en' ? 'ar' : 'en'));
    menuToggle.addEventListener('click', () => setMenuOpen(!header.classList.contains('is-menu-open')));
    $$('.main-nav a, .brand').forEach((link) => link.addEventListener('click', () => setMenuOpen(false)));
    window.addEventListener('resize', () => { if (window.innerWidth > 800) setMenuOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenuOpen(false); });

    window.addEventListener('scroll', () => {
      header.classList.toggle('is-sticky', window.scrollY > 45);
      const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      $('#scroll-progress').style.width = `${Math.min(100, (window.scrollY / range) * 100)}%`;
    });

    // chat
    ui.input.maxLength = CONFIG.maxMessageLength;
    ui.input.addEventListener('input', updateSendEnabled);
    ui.form.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(ui.input.value); });
    ui.alertRetry.addEventListener('click', () => { if (state.lastFailedMessage) sendMessage(state.lastFailedMessage, { retry: true }); });
    ui.reset.addEventListener('click', resetConversation);
    $('#hero-start').addEventListener('click', () => setTimeout(() => ui.input.focus({ preventScroll: true }), motionReduced ? 0 : 500));

    // summary
    ui.confirm.addEventListener('click', () => confirmBooking());
    ui.newBooking.addEventListener('click', () => {
      resetDraft();
      state.conversationId = uuid();                                 // the finished booking's draft is closed: a new booking is a new conversation
      addMessage({ role: 'ai', text: REPLIES[state.chatLang].reset, lang: state.chatLang });
      renderSummary();
      renderChips();
      ui.input.focus({ preventScroll: true });
    });
    // history
    ui.viewAll.addEventListener('click', () => { state.history.showAll = !state.history.showAll; renderHistory(); });
  }

  function init() {
    let language = 'en';
    const saved = store.get(CONFIG.storage.language);
    if (saved === 'ar') language = 'ar';
    $('#year').textContent = String(new Date().getFullYear());
    bindEvents();
    setLanguage(language);
    loadHistory();
    if (CONFIG.mode === 'api') getSession().then((session) => { if (!session) showAuthRequired(); });   // signed out: the summary hint says so (no banner), nothing is sent
  }
  init();
})();