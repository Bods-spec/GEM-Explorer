/**
 * GEM Explorer - Homepage interactions
 * No framework or build step required.
 * Student 1 maintains the app shell, navigation, and integration points.
 */
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const motionReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // All visitor-facing strings live here until we add a CMS / database.
  const translations = {
    en: {
      skip: 'Skip to content', navHome: 'Home', navMuseum: 'The Museum',
      navCollection: 'Collection', navExperience: 'Experience', navVisit: 'Plan a Visit',
      headerExplore: 'Explore now', heroSerial: 'AN IMMERSIVE MUSEUM EXPERIENCE',
      heroExplore: 'Begin exploring', heroCollection: 'View the collection',
      scroll: 'SCROLL TO EXPLORE', heroSide: 'THE GRAND EGYPTIAN MUSEUM',
      discoverEyebrow: 'A NEW WAY TO DISCOVER', discoverHeadingA: 'A museum built for',
      discoverHeadingB: 'the ages.',
      discoverLead: 'Just moments from the Pyramids of Giza, the Grand Egyptian Museum brings the story of ancient Egyptian civilization into a remarkable modern space.',
      discoverBody: 'This independent student experience is your introduction to iconic galleries, monumental architecture, and extraordinary treasures.',
      discoverLink: 'Discover the experience', discoverFine: 'A PLACE WHERE PAST MEETS FUTURE',
      discoverCaption: 'ARCHITECTURE THAT INSPIRES',
      collectionEyebrow: 'CURATED HIGHLIGHTS', collectionNote: 'STORIES WORTH EXPLORING',
      collectionHeadingA: 'Timeless', collectionHeadingB: 'treasures.',
      collectionLead: "Explore three remarkable chapters of the museum's story. Select a highlight to learn more.",
      maskTitle: 'The Golden Mask', maskSubtitle: 'The legacy of Tutankhamun',
      stairsTitle: 'The Grand Stairs', stairsSubtitle: 'A walk among the kings',
      boatTitle: "Khufu's Boat", boatSubtitle: 'A journey across millennia',
      collectionFootnote: 'Photography: Wikimedia Commons contributors. Educational project, not affiliated with the museum.',
      journeyEyebrow: 'MAKE IT YOUR JOURNEY', journeyHeadingA: 'Every step,', journeyHeadingB: 'a discovery.',
      journeyLead: 'A glimpse of what makes the Grand Egyptian Museum an unforgettable cultural destination.',
      journeyItem1Title: 'Enter the Grand Hall', journeyItem1Desc: 'Take in vast contemporary architecture and monumental ancient sculptures.',
      journeyItem2Title: 'Discover ancient worlds', journeyItem2Desc: 'Explore galleries that follow centuries of Egyptian history.',
      journeyItem3Title: 'Meet the treasures', journeyItem3Desc: 'Encounter the iconic objects and stories preserved for future generations.',
      visitEyebrow: 'YOUR ADVENTURE STARTS HERE', visitHeadingA: 'Step into', visitHeadingB: 'history.',
      visitLead: 'Ready to see it for yourself? Explore the museum and check visiting information through its official website.',
      visitOfficial: 'Official museum tickets', visitWebsite: 'Official GEM website',
      visitDisclaimer: 'GEM Explorer is an educational student project. We do not sell tickets or handle payments.',
      footerTag: 'Ancient stories. A new perspective.', footerOfficial: 'Official Museum ↗',
      footerDisclaimer: 'Independent educational prototype · Not an official museum service',
      footerCredits: 'Image credits', dialogEyebrow: 'A CLOSER LOOK', dialogBack: 'Back to collection',
      sliderPrevious: 'Previous slide', sliderNext: 'Next slide', dialogClose: 'Close details',
      menuOpen: 'Open menu', menuClose: 'Close menu',
      slides: [
        { kicker: 'GIZA, EGYPT · AN ETERNAL STORY', main: 'Where history', accent: 'comes alive.', description: 'Travel through the wonders of ancient Egypt, one extraordinary story at a time.' },
        { kicker: 'GRAND STAIRS · A MONUMENTAL JOURNEY', main: 'Walk among', accent: 'the legends.', description: 'Discover a place where monumental architecture and ancient kings share the same stage.' },
        { kicker: "KHUFU'S BOAT · AN ENGINEERING MARVEL", main: 'Across the sands,', accent: 'across time.', description: 'Journey into the imagination and ingenuity of a civilization that changed the world.' }
      ],
      artifacts: {
        mask: 'The golden funerary mask of Tutankhamun is one of the most celebrated treasures of ancient Egypt. Its exquisite craftsmanship offers a glimpse into royal burial traditions and the artistry of the New Kingdom.',
        stairs: 'The Grand Stairs lead visitors past a remarkable sequence of monumental sculptures. The staircase itself becomes part of the story, linking spectacular ancient objects to the museum’s modern architecture.',
        boat: "Khufu's ancient wooden boat is preserved at the dedicated Khufu's Boats Museum within the Grand Egyptian Museum complex. It is an extraordinary testament to ancient Egyptian craftsmanship."
      }
    },
    ar: {
      skip: 'انتقل للمحتوى', navHome: 'الرئيسية', navMuseum: 'عن المتحف',
      navCollection: 'المعروضات', navExperience: 'التجربة', navVisit: 'خطط لزيارتك',
      headerExplore: 'استكشف الآن', heroSerial: 'تجربة استكشاف استثنائية',
      heroExplore: 'ابدأ الاستكشاف', heroCollection: 'شاهد المعروضات',
      scroll: 'مرر للاستكشاف', heroSide: 'المتحف المصري الكبير',
      discoverEyebrow: 'اكتشف التاريخ بطريقة جديدة', discoverHeadingA: 'متحف صُمم',
      discoverHeadingB: 'ليعبر العصور',
      discoverLead: 'على مقربة من أهرامات الجيزة، يجمع المتحف المصري الكبير روائع الحضارة المصرية القديمة داخل صرح معماري معاصر ومذهل.',
      discoverBody: 'هذه التجربة التعليمية المستقلة تعرفك على القاعات الشهيرة والعمارة الاستثنائية والكنوز الأثرية الفريدة.',
      discoverLink: 'اكتشف التجربة', discoverFine: 'حيث يلتقي الماضي بالمستقبل',
      discoverCaption: 'عمارة تلهم الزائرين',
      collectionEyebrow: 'مختارات من الكنوز', collectionNote: 'حكايات تستحق الاكتشاف',
      collectionHeadingA: 'كنوز', collectionHeadingB: 'خالدة',
      collectionLead: 'استكشف ثلاثة من أبرز ملامح المتحف. اضغط على أي بطاقة لمعرفة المزيد.',
      maskTitle: 'القناع الذهبي', maskSubtitle: 'إرث توت عنخ آمون',
      stairsTitle: 'الدرج العظيم', stairsSubtitle: 'رحلة بين الملوك',
      boatTitle: 'مركب خوفو', boatSubtitle: 'رحلة عبر آلاف السنين',
      collectionFootnote: 'الصور من مساهمي ويكيميديا كومنز. مشروع تعليمي غير تابع لإدارة المتحف.',
      journeyEyebrow: 'اجعلها رحلتك الخاصة', journeyHeadingA: 'كل خطوة', journeyHeadingB: 'اكتشاف',
      journeyLead: 'لمحة عن أهم التجارب التي تجعل زيارة المتحف المصري الكبير رحلة ثقافية لا تُنسى.',
      journeyItem1Title: 'ادخل البهو العظيم', journeyItem1Desc: 'شاهد العمارة المعاصرة الرحبة والتماثيل الأثرية الضخمة.',
      journeyItem2Title: 'اكتشف عوالم الماضي', journeyItem2Desc: 'تجول بين قاعات تروي قرونًا من التاريخ المصري.',
      journeyItem3Title: 'تعرف على الكنوز', journeyItem3Desc: 'اقترب من القطع والقصص التي حُفظت للأجيال القادمة.',
      visitEyebrow: 'مغامرتك تبدأ هنا', visitHeadingA: 'ادخل إلى', visitHeadingB: 'عالم التاريخ',
      visitLead: 'مستعد لتجربة الزيارة بنفسك؟ تعرف على المتحف وراجع تفاصيل الزيارة عبر موقعه الرسمي.',
      visitOfficial: 'التذاكر الرسمية للمتحف', visitWebsite: 'الموقع الرسمي للمتحف',
      visitDisclaimer: 'GEM Explorer مشروع طلابي تعليمي، ولا يبيع تذاكر أو يعالج أي مدفوعات.',
      footerTag: 'حكايات قديمة. منظور جديد.', footerOfficial: 'الموقع الرسمي ↗',
      footerDisclaimer: 'نموذج تعليمي مستقل · ليس خدمة رسمية للمتحف',
      footerCredits: 'حقوق الصور', dialogEyebrow: 'نظرة أقرب', dialogBack: 'العودة للمعروضات',
      sliderPrevious: 'الصورة السابقة', sliderNext: 'الصورة التالية', dialogClose: 'إغلاق التفاصيل',
      menuOpen: 'فتح القائمة', menuClose: 'إغلاق القائمة',
      slides: [
        { kicker: 'الجيزة، مصر · حكاية لا تنتهي', main: 'حين يعود', accent: 'التاريخ للحياة', description: 'ارحل عبر عجائب مصر القديمة، واكتشف قصة استثنائية وراء كل أثر.' },
        { kicker: 'الدرج العظيم · رحلة مهيبة', main: 'سر بين', accent: 'أساطير الملوك', description: 'اكتشف مكانًا تتلاقى فيه التماثيل العظيمة مع العمارة الحديثة.' },
        { kicker: 'مركب خوفو · عبقرية الهندسة', main: 'عبر الرمال', accent: 'وعبر الزمان', description: 'تعرف على إبداع حضارة تركت أثرًا خالدًا في التاريخ الإنساني.' }
      ],
      artifacts: {
        mask: 'القناع الجنائزي الذهبي لتوت عنخ آمون من أشهر كنوز مصر القديمة. تكشف دقة صناعته جانبًا من تقاليد الدفن الملكي وفنون عصر الدولة الحديثة.',
        stairs: 'يقود الدرج العظيم الزائرين بين مجموعة من التماثيل الأثرية الضخمة. وهو تجربة تجمع جمال القطع القديمة مع العمارة المعاصرة للمتحف.',
        boat: 'يُعرض المركب الخشبي للملك خوفو في متحف مراكب خوفو داخل مجمع المتحف المصري الكبير، ويُعد شاهدًا على مهارة المصريين القدماء في صناعة السفن.'
      }
    }
  };

  const storageKey = 'gem-explorer-language';
  let language = 'en';
  try { language = localStorage.getItem(storageKey) === 'ar' ? 'ar' : 'en'; } catch (_) { /* private mode */ }
  let slideIndex = 0;
  let slideTimer = null;
  const SLIDE_DELAY = 7000;
  const slides = $$('.hero__slide');
  const hero = $('.hero');
  const menuToggle = $('#menu-toggle');
  const header = $('#site-header');
  const langToggle = $('#lang-toggle');
  const modal = $('#artifact-dialog');
  let lastFocusedElement = null;

  function renderSlide() {
    slides.forEach((slide, index) => slide.classList.toggle('is-active', index === slideIndex));
    const data = translations[language].slides[slideIndex];
    $('#hero-kicker').textContent = data.kicker;
    $('#hero-title-main').textContent = data.main;
    $('#hero-title-accent').textContent = data.accent;
    $('#hero-description').textContent = data.description;
    $('#current-slide').textContent = String(slideIndex + 1).padStart(2, '0');
    const progress = $('#slide-progress');
    progress.style.transition = 'none';
    progress.style.width = '0%';
    // Forces style update so the CSS progress animation restarts on slide changes.
    void progress.offsetWidth;
    if (!motionReduced && !document.hidden) {
      progress.style.transition = `width ${SLIDE_DELAY}ms linear`;
      progress.style.width = '100%';
    }
  }

  function pauseSlides() {
    window.clearInterval(slideTimer);
    slideTimer = null;
    const progress = $('#slide-progress');
    progress.style.transition = 'none';
    progress.style.width = '0%';
  }

  function startSlides() {
    if (motionReduced || document.hidden || slideTimer) return;
    renderSlide();
    slideTimer = window.setInterval(() => {
      slideIndex = (slideIndex + 1) % slides.length;
      renderSlide();
    }, SLIDE_DELAY);
  }

  function changeSlide(step) {
    slideIndex = (slideIndex + step + slides.length) % slides.length;
    pauseSlides();
    renderSlide();
    startSlides();
  }

  function setLanguage(nextLanguage) {
    language = nextLanguage;
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    const dictionary = translations[language];
    $$('[data-i18n]').forEach((node) => {
      const key = node.dataset.i18n;
      if (dictionary[key] !== undefined) node.textContent = dictionary[key];
    });
    langToggle.textContent = language === 'en' ? 'عربي' : 'EN';
    langToggle.setAttribute('aria-label', language === 'en' ? 'Switch language to Arabic' : 'تغيير اللغة إلى الإنجليزية');
    $('#prev-slide').setAttribute('aria-label', dictionary.sliderPrevious);
    $('#next-slide').setAttribute('aria-label', dictionary.sliderNext);
    $('#dialog-close').setAttribute('aria-label', dictionary.dialogClose);
    menuToggle.setAttribute('aria-label', dictionary.menuOpen);
    document.title = language === 'ar' ? 'GEM Explorer | رحلة عبر الزمن' : 'GEM Explorer | A Journey Beyond Time';
    renderSlide();
    if (modal.open) updateDialog(modal.dataset.currentArtifact);
    try { localStorage.setItem(storageKey, language); } catch (_) { /* private mode */ }
  }

  function setMenuOpen(isOpen) {
    header.classList.toggle('is-menu-open', isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', translations[language][isOpen ? 'menuClose' : 'menuOpen']);
  }

  const artifactTitles = { mask: 'maskTitle', stairs: 'stairsTitle', boat: 'boatTitle' };
  function updateDialog(id) {
    const source = $(`[data-artifact="${id}"] img`);
    if (!source || !artifactTitles[id]) return;
    $('#dialog-title').textContent = translations[language][artifactTitles[id]];
    $('#dialog-description').textContent = translations[language].artifacts[id];
    $('#dialog-image').src = source.src;
    $('#dialog-image').alt = source.alt;
    modal.dataset.currentArtifact = id;
  }
  function openArtifact(id) {
    if (typeof modal.showModal !== 'function') return;
    lastFocusedElement = document.activeElement;
    updateDialog(id);
    modal.showModal();
    document.body.classList.add('is-modal-open');
  }
  function closeArtifact() { if (modal.open) modal.close(); }

  // Events: controls and navigation
  $('#prev-slide').addEventListener('click', () => changeSlide(-1));
  $('#next-slide').addEventListener('click', () => changeSlide(1));
  hero.addEventListener('mouseenter', pauseSlides);
  hero.addEventListener('mouseleave', startSlides);
  document.addEventListener('visibilitychange', () => document.hidden ? pauseSlides() : startSlides());
  menuToggle.addEventListener('click', () => setMenuOpen(!header.classList.contains('is-menu-open')));
  $$('.main-nav a, .brand').forEach(link => link.addEventListener('click', () => setMenuOpen(false)));
  langToggle.addEventListener('click', () => setLanguage(language === 'en' ? 'ar' : 'en'));
  window.addEventListener('resize', () => { if (window.innerWidth > 800) setMenuOpen(false); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenuOpen(false); });
  $$('.artifact-card').forEach(card => card.addEventListener('click', () => openArtifact(card.dataset.artifact)));
  $('#dialog-close').addEventListener('click', closeArtifact);
  $('#dialog-back').addEventListener('click', closeArtifact);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeArtifact(); // click on backdrop
  });
  modal.addEventListener('close', () => {
    document.body.classList.remove('is-modal-open');
    lastFocusedElement?.focus();
  });

  // Header state + page reading progress (throttled by requestAnimationFrame).
  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(() => {
      header.classList.toggle('is-sticky', window.scrollY > 45);
      const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      $('#scroll-progress').style.width = `${Math.min(100, (window.scrollY / range) * 100)}%`;
      scrollTicking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Reveal on entry: progressive enhancement; fallback keeps everything visible.
  if ('IntersectionObserver' in window && !motionReduced) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .12, rootMargin: '0px 0px -25px 0px' });
    $$('.reveal').forEach(element => observer.observe(element));
  } else {
    $$('.reveal').forEach(element => element.classList.add('is-visible'));
  }

  // Highlight active nav section when visible.
  if ('IntersectionObserver' in window) {
    const navObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        $$('.nav-link').forEach(link => link.classList.toggle('is-current', link.getAttribute('href') === `#${entry.target.id}`));
      });
    }, { rootMargin: '-25% 0px -60% 0px' });
    $$('main > section[id]').forEach(section => navObserver.observe(section));
  }

  $('#year').textContent = String(new Date().getFullYear());
  setLanguage(language);
  startSlides();
})();
