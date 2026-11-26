"""Words, rules and fixed replies of the AI Museum Guide. No AI and no network in this file.

* register(message)       -> "en" | "ar" (standard Arabic) | "eg" (Egyptian Arabic)
* booking_action(message) -> "create" | "modify" | "cancel" | "lookup" | None
* small_talk(message)     -> "greeting" | "thanks" | "bye" | "about" | None
* reply(kind, reg, ...)   -> a fixed, human-written reply

Everything the guide says WITHOUT using the evidence (greetings, refusals, handoffs, reminders)
is written here, by people, so it can be read and tested. The AI only writes the factual answer.
"""

import re

from .domain import fold
from .rag import detect_language

_EGYPTIAN_WORDS = frozenset(
    "ايه ازاي ازيك فين امتى ليه كده دلوقتي دلوقت بتاعي بتاعتي عايز عايزه عاوز عاوزه عايزين احكيلي قولي قولّي بتاع بتاعت بتاعه "
    "مين ده دي دا دول هشوف هروح بيفتح بيقفل كام فيه ممكن اوي خالص برضه يعني الدهب".split()
)

# Words that make the sentence Egyptian even when many other words are standard.
_EGYPTIAN_STRONG = frozenset("ايه ازاي فين امتى كده بتاعي دلوقتي عايز عايزه عاوز عاوزه احكيلي بتاع بيفتح هشوف اوي ازيك ازيكم".split())


def register(message: str) -> str:
    """'en' for English, 'eg' for Egyptian Arabic (dialect words), 'ar' for other Arabic."""
    if detect_language(message) != "ar":
        return "en"
    words = set(fold(message).split())
    words |= {w[1:] for w in words if len(w) > 3 and w[0] == "و"}          # "وفين" = "و" + "فين"
    return "eg" if words & _EGYPTIAN_STRONG else "ar"


def language_of(reg: str) -> str:
    return "ar" if reg in ("ar", "eg") else "en"


# ---------------------------------------------------------------------------
# booking intent: the guide never books; it hands over
# ---------------------------------------------------------------------------

_AR = "ء-ي"
_BOOKING_EN = re.compile(
    r"(?:\b(?:book|booked|booking|bookings|reserve|reserved|reservation|reservations|reschedule|rebook)\b"
    r"(?=.*\b(?:ticket|tickets|visit|tour|slot|slots|entry|admission|seat|seats|date|time|day|me|us|my|for|a|an|the|please)\b)"
    r"|\b(?:my|the)\s+(?:booking|reservation)\b|\bbooking\s+(?:reference|number|id|code)\b)"
)
_REFERENCE = re.compile(r"\bGEM[-\u2010-\u2015][A-Z0-9]{3,}", re.IGNORECASE)    # a booking reference such as GEM-AB12CD
# "book" as a noun ("a book about the pharaohs") must not trigger a handoff
_BOOK_NOUN = re.compile(r"\bbooks?\s+(?:about|of|on|shop|store|by)\b|\b(?:a|the)\s+books?\b(?!\s+(?:a|me|us|for|my|the|tickets?))")
_BOOKING_AR = re.compile(
    rf"(?<![{_AR}])[وفبكل]?(?:ال)?(?:حجز|حجوزات|احجز\w*|حجزي|حجزلي|نحجز|حجزت|كنسل)(?![{_AR}])|(?:الغ|ألغ)\w*\s+(?:ال)?(?:تذكر|زيار|حجز)"
)

# what the visitor wants to do with a booking (the first matching rule wins)
_ACTIONS = (
    ("cancel", re.compile(r"\bcancel|الغ|كنسل")),
    ("modify", re.compile(r"\breschedule|\bchange|\bmodify|\bmove\b|\bedit\b|\bupdate|\bpostpone|\brebook|تعديل|عدل|غير|اجل|تاجيل|نقل")),
    ("lookup", re.compile(r"\b(?:my|the)\s+(?:booking|reservation)\b|\bbooking\s+(?:reference|number|id|code|status)\b|حجزي|رقم\s+(?:ال)?حجز|مرجع")),
)


def booking_action(message: str) -> str | None:
    """What the visitor wants to do with a booking, or None if the message is not about booking."""
    text = fold(message).strip()
    has_reference = bool(_REFERENCE.search(message))
    if not has_reference:
        if _BOOK_NOUN.search(text) and not re.search(r"\b(?:ticket|tickets|visit|tour)\b", text):
            return None
        if not (_BOOKING_EN.search(text) or _BOOKING_AR.search(text)):
            return None
    for action, pattern in _ACTIONS:
        if pattern.search(text):
            return action
    return "lookup" if has_reference else "create"


# ---------------------------------------------------------------------------
# greetings, thanks, "what can you do"
# ---------------------------------------------------------------------------

_SMALL_TALK = (
    ("about", re.compile(r"who are you|what are you|what can you do|what do you do|how can you help|can you help|help me|انت مين|انتي مين|مين انت|تقدر تعمل ايه|ماذا تستطيع|ما الذي تستطيع|ممكن تساعدني|هل تستطيع مساعدتي|ساعدني")),
    ("thanks", re.compile(r"^(?:thanks?|thank you|thx|ty|many thanks|cheers|شكرا|شكرا جزيلا|متشكر\w*|تسلم\w*|ميرسي|الف شكر|جزاك الله خيرا)\b")),
    ("bye", re.compile(r"^(?:bye|goodbye|see you|good night|مع السلامه|الي اللقاء|سلام|تصبح على خير)\b")),
    ("greeting", re.compile(r"^(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|greetings|salam|مرحبا|مرحبتين|اهلا|اهلين|السلام عليكم|سلام عليكم|صباح الخير|مساء الخير|هاي|ازيك|ازيكم|هلا|يا هلا)\b")),
)


def small_talk(message: str) -> str | None:
    text = fold(message).strip()
    words = text.split()
    if not words or len(words) > 5:
        return None
    for kind, pattern in _SMALL_TALK:
        if pattern.search(text):
            return kind
    return None


# ---------------------------------------------------------------------------
# fixed replies
# ---------------------------------------------------------------------------

OFFICIAL_SITE = "https://gem.eg"

_SUGGEST = {
    "en": "I can help with opening hours, the Tutankhamun Galleries, the Grand Hall, the Hanging Obelisk, the Grand Stairs, Khufu's Boats Museum and the museum's most famous artefacts.",
    "ar": "يمكنني مساعدتك في مواعيد العمل، وقاعات توت عنخ آمون، والبهو العظيم، والمسلة المعلقة، والدرج العظيم، ومتحف مراكب الملك خوفو، وأشهر القطع الأثرية في المتحف.",
    "eg": "أقدر أساعدك في مواعيد العمل، وقاعات توت عنخ آمون، والبهو العظيم، والمسلة المعلقة، والدرج العظيم، ومتحف مراكب الملك خوفو، وأشهر القطع الأثرية في المتحف.",
}

_TEXT: dict[str, dict[str, str]] = {
    "greeting": {
        "en": "Hello and welcome! I'm the GEM Explorer guide for the Grand Egyptian Museum. {suggest} What would you like to know?",
        "ar": "أهلًا بك! أنا مرشد GEM Explorer للمتحف المصري الكبير. {suggest} بماذا تحب أن أساعدك؟",
        "eg": "أهلًا بيك! أنا مرشد GEM Explorer للمتحف المصري الكبير. {suggest} تحب تعرف إيه؟",
    },
    "about": {
        "en": "I'm the GEM Explorer guide. I answer questions about the Grand Egyptian Museum using verified notes from the museum's official pages, and I always show where an answer comes from. I can't make or change bookings myself, but I can point you to the booking section. {suggest}",
        "ar": "أنا مرشد GEM Explorer. أجيب عن أسئلتك حول المتحف المصري الكبير اعتمادًا على ملاحظات موثّقة من صفحات المتحف الرسمية، وأذكر دائمًا مصدر كل إجابة. لا أستطيع إجراء الحجز أو تعديله بنفسي، لكن يمكنني توجيهك إلى قسم الحجز. {suggest}",
        "eg": "أنا مرشد GEM Explorer. باجاوب على أسئلتك عن المتحف المصري الكبير من ملاحظات موثّقة من صفحات المتحف الرسمية، ودايمًا باقولك المصدر. مقدرش أحجز أو أعدّل حجز بنفسي، بس أوجّهك لقسم الحجز. {suggest}",
    },
    "thanks": {
        "en": "You're welcome! Ask me anything else about the museum.",
        "ar": "على الرحب والسعة! اسألني عن أي شيء آخر في المتحف.",
        "eg": "العفو! اسألني عن أي حاجة تانية في المتحف.",
    },
    "bye": {
        "en": "Goodbye, and enjoy your visit to the Grand Egyptian Museum!",
        "ar": "مع السلامة، واستمتع بزيارتك للمتحف المصري الكبير!",
        "eg": "مع السلامة، واستمتع بزيارتك للمتحف المصري الكبير!",
    },
    "no_info": {
        "en": "I'm sorry, I can't find that in my verified sources about the Grand Egyptian Museum, so I'd rather not guess. For anything I can't confirm, please check the official website ({site}). {suggest}",
        "ar": "عذرًا، لا أجد هذه المعلومة في مصادري الموثّقة عن المتحف المصري الكبير، ولا أريد أن أخمّن. وللتأكد من أي شيء لا أستطيع تأكيده، يُرجى الرجوع إلى الموقع الرسمي ({site}). {suggest}",
        "eg": "آسف، مش لاقي المعلومة دي في مصادري الموثّقة عن المتحف المصري الكبير، ومش عايز أخمّن. ولو عايز تتأكد من حاجة معرفش أأكدها، راجع الموقع الرسمي ({site}). {suggest}",
    },
    "other_museum": {
        "en": "I only have verified information about the Grand Egyptian Museum, so I can't help with the {museum}. For that, please check that museum's official website. {suggest}",
        "ar": "لدي معلومات موثّقة عن المتحف المصري الكبير فقط، لذلك لا أستطيع المساعدة بخصوص «{museum}». يُرجى الرجوع إلى الموقع الرسمي لذلك المتحف. {suggest}",
        "eg": "معايا معلومات موثّقة عن المتحف المصري الكبير بس، فمقدرش أساعدك في «{museum}». راجع الموقع الرسمي للمتحف ده. {suggest}",
    },
    "unavailable": {
        "en": "I can't check my verified sources right now, so I'd rather not answer from memory. Please try again in a moment.",
        "ar": "لا أستطيع الوصول إلى مصادري الموثّقة الآن، ولا أريد أن أجيب من الذاكرة. يُرجى المحاولة بعد قليل.",
        "eg": "مش قادر أوصل لمصادري الموثّقة دلوقتي، ومش عايز أجاوب من الذاكرة. جرّب كمان شوية.",
    },
    "unverified": {
        "en": "I couldn't verify a reliable answer to that from my sources, so I'd rather not risk giving you wrong information. Please check the official website ({site}).",
        "ar": "لم أتمكن من التحقق من إجابة موثوقة لهذا السؤال من مصادري، ولا أريد المخاطرة بإعطائك معلومة خاطئة. يُرجى الرجوع إلى الموقع الرسمي ({site}).",
        "eg": "معرفتش أتحقق من إجابة موثوقة للسؤال ده من مصادري، ومش عايز أديك معلومة غلط. راجع الموقع الرسمي ({site}).",
    },
    "partial": {
        "en": "I don't have verified information about the rest of your question.",
        "ar": "ليست لدي معلومات موثّقة عن بقية سؤالك.",
        "eg": "معنديش معلومات موثّقة عن باقي سؤالك.",
    },
    "time_sensitive": {
        "en": "Details like this can change, so please confirm on the official website ({site}) before you visit.",
        "ar": "قد تتغير مثل هذه التفاصيل، لذا يُرجى التأكد من الموقع الرسمي ({site}) قبل زيارتك.",
        "eg": "التفاصيل دي ممكن تتغير، فاتأكد من الموقع الرسمي ({site}) قبل ما تزور.",
    },
    "handoff_create": {
        "en": "I can't make bookings myself, but you can book your visit in the booking section of GEM Explorer. I'll be here if you have questions about the museum.",
        "ar": "لا أستطيع إجراء الحجز بنفسي، لكن يمكنك حجز زيارتك من قسم الحجز في GEM Explorer. وأنا هنا إن كانت لديك أسئلة عن المتحف.",
        "eg": "مقدرش أحجز بنفسي، بس تقدر تحجز زيارتك من قسم الحجز في GEM Explorer. وأنا هنا لو عندك أي سؤال عن المتحف.",
    },
    "handoff_modify": {
        "en": "I can't change bookings myself. Please use the booking section of GEM Explorer to manage your booking with its reference number.",
        "ar": "لا أستطيع تعديل الحجوزات بنفسي. يُرجى استخدام قسم الحجز في GEM Explorer لإدارة حجزك بواسطة رقم الحجز.",
        "eg": "مقدرش أعدّل الحجز بنفسي. استخدم قسم الحجز في GEM Explorer وادخل رقم الحجز بتاعك.",
    },
    "handoff_cancel": {
        "en": "I can't cancel bookings myself. Please use the booking section of GEM Explorer to cancel with your booking reference number.",
        "ar": "لا أستطيع إلغاء الحجوزات بنفسي. يُرجى استخدام قسم الحجز في GEM Explorer للإلغاء بواسطة رقم الحجز.",
        "eg": "مقدرش ألغي الحجز بنفسي. استخدم قسم الحجز في GEM Explorer وادخل رقم الحجز بتاعك.",
    },
    "handoff_lookup": {
        "en": "I can't look up bookings. Please use the booking section of GEM Explorer with your booking reference number.",
        "ar": "لا أستطيع الاطلاع على الحجوزات. يُرجى استخدام قسم الحجز في GEM Explorer مع رقم الحجز.",
        "eg": "مقدرش أشوف الحجوزات. استخدم قسم الحجز في GEM Explorer وادخل رقم الحجز بتاعك.",
    },
}


def reply(kind: str, reg: str, **values) -> str:
    """A fixed reply in the visitor's register (en / ar / eg)."""
    text = _TEXT[kind][reg]
    return text.format(site=OFFICIAL_SITE, suggest=_SUGGEST[reg], **values)


def language_name(reg: str) -> str:
    return {"en": "English", "ar": "Modern Standard Arabic", "eg": "Egyptian Arabic (simple and friendly, but exact with names and facts)"}[reg]