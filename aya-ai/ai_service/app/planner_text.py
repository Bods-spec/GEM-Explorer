"""Every sentence the Visit Planner says. Fixed templates in English, Modern Standard Arabic and Egyptian Arabic:
the model never writes any text the visitor sees, so it cannot add a fact, a number or a link.
"""

TAG_LABELS = {
    "kings": ("kings", "الملوك"), "obelisks": ("obelisks", "المسلات"), "architecture": ("architecture", "العمارة"),
    "ramesses": ("Ramesses II", "رمسيس الثاني"), "photography": ("photography", "التصوير"),
    "statues": ("statues", "التماثيل"), "gods": ("gods and goddesses", "المعبودات"), "history": ("history", "التاريخ"),
    "daily-life": ("daily life", "الحياة اليومية"), "funerary": ("funerary art", "الفن الجنائزي"),
    "tutankhamun": ("Tutankhamun", "توت عنخ آمون"), "gold": ("gold", "الذهب"), "treasures": ("treasures", "الكنوز"),
    "boats": ("boats", "المراكب"), "pyramids": ("the pyramids", "الأهرامات"),
}

_T = {
    "greeting": {
        "en": "Hello! I'm Egyxos, your visit planner for the Grand Egyptian Museum. Tell me how much time you have and what you would like to see, and I'll build a plan you can change any time.",
        "ar": "مرحبًا! أنا إيجكسوس، مخطط زيارتك للمتحف المصري الكبير. أخبرني بالوقت المتاح لديك وما تحب أن تراه، وسأعد لك خطة يمكنك تعديلها في أي وقت.",
        "eg": "أهلاً! أنا إيجكسوس، بخطّطلك زيارتك للمتحف المصري الكبير. قولّي عندك كام وقت وعايز تشوف إيه، وأنا أعملك خطة تقدر تعدّلها في أي وقت.",
    },
    "ask_time": {
        "en": "How much time do you have for your visit? For example “two hours” or “90 minutes”. You can also tell me what you would like to see.",
        "ar": "كم من الوقت لديك لزيارتك؟ مثلًا «ساعتان» أو «90 دقيقة». ويمكنك أيضًا إخباري بما تحب أن تراه.",
        "eg": "عندك كام وقت للزيارة؟ مثلًا «ساعتين» أو «90 دقيقة». وممكن كمان تقولّي عايز تشوف إيه.",
    },
    "time_conflict": {
        "en": "I understood two different amounts of time from your message. How many minutes do you have in total?",
        "ar": "فهمت من رسالتك مدتين مختلفتين. كم دقيقة لديك في المجموع؟",
        "eg": "فهمت من رسالتك مدتين مختلفين. عندك كام دقيقة في المجموع؟",
    },
    "not_planning": {
        "en": "I plan museum visits. Tell me how much time you have and what you would like to see. For questions about the museum itself, please ask the Museum Guide.",
        "ar": "أنا أخطط زيارات المتحف. أخبرني بالوقت المتاح لديك وما تحب أن تراه. أما الأسئلة عن المتحف نفسه فاسأل المرشد الذكي للمتحف.",
        "eg": "أنا بخطّط زيارات المتحف. قولّي عندك كام وقت وعايز تشوف إيه. أما الأسئلة عن المتحف نفسه فاسأل المرشد الذكي.",
    },
    "intro_new": {
        "en": "Here is a plan for your {budget} minutes at the Grand Egyptian Museum (about {total} minutes including short walking breaks):",
        "ar": "هذه خطة لوقتك البالغ {budget} دقيقة في المتحف المصري الكبير (حوالي {total} دقيقة شاملة فترات المشي القصيرة):",
        "eg": "دي خطة لوقتك اللي هو {budget} دقيقة في المتحف المصري الكبير (حوالي {total} دقيقة بما فيها فترات المشي القصيرة):",
    },
    "intro_updated": {
        "en": "Done, here is your updated plan for {budget} minutes (about {total} minutes including short walking breaks):",
        "ar": "تم، هذه خطتك المعدّلة لمدة {budget} دقيقة (حوالي {total} دقيقة شاملة فترات المشي القصيرة):",
        "eg": "تمام، دي خطتك بعد التعديل لمدة {budget} دقيقة (حوالي {total} دقيقة بما فيها فترات المشي القصيرة):",
    },
    "stop": {
        "en": "{n}. {name}: about {minutes} min",
        "ar": "{n}. {name}: حوالي {minutes} دقيقة",
        "eg": "{n}. {name}: حوالي {minutes} دقيقة",
    },
    "why_must_see": {
        "en": "   Why: you asked for {names}.", "ar": "   السبب: طلبت {names}.", "eg": "   السبب: انت طلبت {names}.",
    },
    "why_interest": {
        "en": "   Why: it matches your interest in {tags}.", "ar": "   السبب: تتوافق مع اهتمامك: {tags}.",
        "eg": "   السبب: بتناسب اهتمامك: {tags}.",
    },
    "why_general": {
        "en": "   Why: it follows the museum's own tour order.", "ar": "   السبب: تتبع ترتيب جولة المتحف نفسها.",
        "eg": "   السبب: بتمشي على ترتيب جولة المتحف نفسه.",
    },
    "why_filler": {
        "en": "   Why: added to use your spare time (optional).", "ar": "   السبب: أُضيفت لاستغلال وقتك المتبقي (اختيارية).",
        "eg": "   السبب: اتضافت عشان نستغل وقتك الباقي (اختيارية).",
    },
    "highlights": {"en": "   Highlights: {names}.", "ar": "   أبرز القطع: {names}.", "eg": "   أبرز القطع: {names}."},
    "rest": {
        "en": "Rest buffer: {minutes} min (no place is assumed).", "ar": "وقت راحة: {minutes} دقيقة (دون تحديد مكان).",
        "eg": "وقت راحة: {minutes} دقيقة (من غير تحديد مكان).",
    },
    "transitions": {
        "en": "Short walking breaks between stops: {minutes} min in total (a flat estimate; I have no map or distance data).",
        "ar": "فترات مشي قصيرة بين المحطات: {minutes} دقيقة في المجموع (تقدير ثابت، ولا تتوفر لدي خرائط أو مسافات).",
        "eg": "فترات مشي قصيرة بين المحطات: {minutes} دقيقة في المجموع (تقدير ثابت، ومعنديش خرائط ولا مسافات).",
    },
    "free": {
        "en": "Spare time left: {minutes} min.", "ar": "الوقت المتبقي: {minutes} دقيقة.", "eg": "الوقت الفاضل: {minutes} دقيقة.",
    },
    "left_out": {
        "en": "I could not fit {names} in {budget} minutes, so I left {it} out. Say, for example, “make it {more} minutes” or remove another stop and I'll update the plan.",
        "ar": "لم أستطع إدخال {names} ضمن {budget} دقيقة، فاستبعدتها. قل مثلًا «اجعلها {more} دقيقة» أو احذف محطة أخرى وسأحدّث الخطة.",
        "eg": "معرفتش أدخّل {names} في {budget} دقيقة فشلتها بره. قولّي مثلًا «خليها {more} دقيقة» أو شيل محطة تانية وأنا أحدّث الخطة.",
    },
    "asked_and_removed": {
        "en": "You asked for {names} but also removed it, so I left it out.",
        "ar": "طلبت {names} ثم حذفتها، لذلك لم أضفها.", "eg": "طلبت {names} وبعدين شيلتها، فمضفتهاش.",
    },
    "no_estimate": {
        "en": "{names}: part of the museum, but I have no verified time estimate or route information for it, so I did not schedule it.",
        "ar": "{names}: جزء من المتحف، لكن ليس لدي تقدير موثّق للوقت ولا معلومات عن المسار، لذلك لم أجدولها.",
        "eg": "{names}: جزء من المتحف، لكن معنديش تقدير موثّق للوقت ولا معلومات عن المسار، فمجدولتهاش.",
    },
    "unmatched": {
        "en": "I have no verified information about {names}, so I did not add anything for that.",
        "ar": "ليست لدي معلومات موثّقة عن {names}، لذلك لم أضف شيئًا لها.",
        "eg": "معنديش معلومات موثّقة عن {names}، فمضفتش حاجة ليها.",
    },
    "capped": {
        "en": "I plan for {minutes} minutes at most.", "ar": "أخطط لـ{minutes} دقيقة كحد أقصى.", "eg": "بخطّط لحد {minutes} دقيقة كحد أقصى.",
    },
    "estimates": {
        "en": "Minutes are our team's estimates, not official museum timings. The order follows the museum's own group-tour description; it is not an optimised route (I have no map or distance data). Please check opening hours on the official site.",
        "ar": "الدقائق تقديرات فريقنا وليست مواعيد رسمية من المتحف. الترتيب يتبع وصف الجولة الجماعية الذي ينشره المتحف، وليس مسارًا محسّنًا (لا تتوفر لدي خرائط أو مسافات). يرجى التأكد من مواعيد العمل في الموقع الرسمي.",
        "eg": "الدقايق دي تقديرات فريقنا مش مواعيد رسمية من المتحف. الترتيب بيتبع وصف الجولة الجماعية اللي ينشره المتحف، مش مسار متحسّن (معنديش خرائط ولا مسافات). اتأكد من مواعيد العمل من الموقع الرسمي.",
    },
    "tip": {
        "en": "Tell me what interests you and I'll prioritise it, or change anything, for example “make it 90 minutes and remove the Grand Stairs”.",
        "ar": "أخبرني بما يهمك لأعطيه الأولوية، أو غيّر أي شيء، مثلًا «اجعلها 90 دقيقة واحذف الدرج العظيم».",
        "eg": "قولّي إيه اللي يهمك وأنا أديله الأولوية، أو غيّر أي حاجة، مثلًا «خليها 90 دقيقة وشيل الدرج العظيم».",
    },
    "too_short": {
        "en": "I can't build a plan in {budget} minutes: even the shortest stop needs about {needed} minutes. How much time do you have in total?",
        "ar": "لا أستطيع إعداد خطة في {budget} دقيقة: حتى أقصر محطة تحتاج حوالي {needed} دقيقة. كم من الوقت لديك في المجموع؟",
        "eg": "مش هقدر أعمل خطة في {budget} دقيقة: حتى أقصر محطة محتاجة حوالي {needed} دقيقة. عندك كام وقت في المجموع؟",
    },
    "must_see_too_long": {
        "en": "{names} cannot fit in {budget} minutes: it needs about {needed} minutes at the very least. I did not make a different plan, because that is not what you asked for. Give me more time, or tell me which of these to drop.",
        "ar": "لا يمكن إدخال {names} ضمن {budget} دقيقة: يلزمها {needed} دقيقة على الأقل. لم أضع خطة مختلفة لأن هذا ليس ما طلبته. أعطني وقتًا أطول، أو أخبرني بما يمكن الاستغناء عنه.",
        "eg": "مينفعش أدخّل {names} في {budget} دقيقة: محتاجة {needed} دقيقة على الأقل. معملتش خطة مختلفة لأن ده مش اللي طلبته. اديني وقت أطول، أو قولّي أشيل إيه.",
    },
    "must_see_no_estimate": {
        "en": "{names}: part of the museum, but I have no verified time estimate or route information for it, so I cannot put it in a timed plan. I did not build a different plan, because that is not what you asked for. Tell me what else you would like to see, or say “plan without it” and I will plan the rest of your time.",
        "ar": "{names}: جزء من المتحف، لكن ليس لدي تقدير موثّق للوقت ولا معلومات عن المسار، لذلك لا أستطيع وضعه في خطة زمنية. لم أعدّ خطة مختلفة لأن هذا ليس ما طلبته. أخبرني بما تريد رؤيته أيضًا، أو قل «خطط بدونه» وسأخطط لباقي وقتك.",
        "eg": "{names}: جزء من المتحف، لكن معنديش تقدير موثّق للوقت ولا معلومات عن المسار، فمقدرش أحطه في خطة بالوقت. معملتش خطة مختلفة لأن ده مش اللي طلبته. قولّي عايز تشوف إيه كمان، أو قول «خطّط من غيره» وأنا أخطّط لباقي وقتك.",
    },
    "budget_assumed": {
        "en": "Your time budget is understood as {minutes} minutes in total. Tell me if that is wrong.",
        "ar": "فهمت أن وقتك المتاح {minutes} دقيقة في المجموع. أخبرني إن كان ذلك غير صحيح.",
        "eg": "فهمت إن وقتك {minutes} دقيقة في المجموع. قولّي لو ده غلط.",
    },
    "no_stops": {
        "en": "I could not find anything I can schedule with those choices. Tell me more about what you would like to see.",
        "ar": "لم أجد ما يمكن جدولته بهذه الاختيارات. أخبرني أكثر بما تحب أن تراه.",
        "eg": "ملقيتش حاجة أقدر أجدولها بالاختيارات دي. قولّي أكتر عايز تشوف إيه.",
    },
}

ASSUMPTIONS = {
    "en": [
        "Minutes per stop are team estimates (scaled by your pace), not official museum timings.",
        "Stops follow the order of the museum's own group-tour description. It is not a computed route: there is no map or distance data.",
        "Time between stops is a flat buffer, not a measured walking time.",
        "Opening hours and ticket availability are not checked here; use the official site.",
        "No floors, rooms or walking distances are given because none are verified.",
    ],
    "ar": [
        "الدقائق لكل محطة تقديرات من فريقنا (معدّلة حسب إيقاعك) وليست مواعيد رسمية من المتحف.",
        "ترتيب المحطات يتبع وصف الجولة الجماعية الذي ينشره المتحف، وليس مسارًا محسوبًا: لا تتوفر خرائط أو مسافات.",
        "الوقت بين المحطات هامش ثابت وليس زمن مشي مقيسًا.",
        "لا يتم التحقق هنا من مواعيد العمل أو توفر التذاكر؛ استخدم الموقع الرسمي.",
        "لا تُذكر طوابق أو قاعات أو مسافات مشي لأنه لا يوجد ما يثبتها.",
    ],
}
ASSUMPTIONS["eg"] = ASSUMPTIONS["ar"]

LIMITATIONS = {
    "en": ["The planner cannot book, change or cancel tickets; booking is done in the booking system.",
           "Only areas with a team-estimated visit time can be scheduled; other places are mentioned but not planned."],
    "ar": ["لا يستطيع المخطط حجز التذاكر أو تعديلها أو إلغاءها؛ يتم الحجز في نظام الحجز.",
           "لا تُجدول إلا المناطق التي لها تقدير زمني من فريقنا؛ وتُذكر الأماكن الأخرى دون تخطيطها."],
}
LIMITATIONS["eg"] = LIMITATIONS["ar"]


def text(kind: str, reg: str, **values) -> str:
    return _T[kind][reg].format(**values)


def join(items: list[str], reg: str) -> str:
    items = [i for i in items if i]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + (" and " if reg == "en" else " و") + items[-1]


def tag_label(tag: str, reg: str) -> str:
    pair = TAG_LABELS.get(tag)
    return pair[0 if reg == "en" else 1] if pair else tag


def language_of(reg: str) -> str:
    return "ar" if reg in ("ar", "eg") else "en"


def render_plan(plan: dict, prefs_budget: int, reg: str, updated: bool, unmatched: list[str]) -> str:
    lines = [text("intro_updated" if updated else "intro_new", reg, budget=prefs_budget, total=plan["total_estimated_minutes"])]
    for stop in plan["stops"]:
        lines.append(text("stop", reg, n=stop["order"], name=stop["name"], minutes=stop["minutes"]))
        because = stop["because"]
        if stop["priority"] == "must_see" and because["asked_for"]:
            lines.append(text("why_must_see", reg, names=join(because["asked_for"], reg)))
        elif stop["priority"] == "interest" and because["interests"]:
            lines.append(text("why_interest", reg, tags=join([tag_label(t, reg) for t in because["interests"]], reg)))
        elif stop["priority"] == "filler":
            lines.append(text("why_filler", reg))
        else:
            lines.append(text("why_general", reg))
        if stop["highlights"]:
            lines.append(text("highlights", reg, names=join([h["name"] for h in stop["highlights"]], reg)))
    if plan["transitions_total"]:
        lines.append(text("transitions", reg, minutes=plan["transitions_total"]))
    if plan["rest_buffer_minutes"]:
        lines.append(text("rest", reg, minutes=plan["rest_buffer_minutes"]))
    if plan["free_minutes"]:
        lines.append(text("free", reg, minutes=plan["free_minutes"]))
    for issue in plan["issues"]:
        code = issue["code"]
        if code == "left_out_for_time":
            lines.append(text("left_out", reg, names=join(issue["names"], reg), budget=prefs_budget,
                              more=prefs_budget + 30, it="it" if len(issue["names"]) == 1 else "them"))
        elif code == "asked_and_removed":
            lines.append(text("asked_and_removed", reg, names=issue["name"]))
        elif code == "capped":
            lines.append(text("capped", reg, minutes=issue["minutes"]))
    missing = [n["name"] for n in plan["not_included"] if n["reason"] == "no_verified_estimate"]
    if missing:
        lines.append(text("no_estimate", reg, names=join(missing, reg)))
    if unmatched:
        lines.append(text("unmatched", reg, names=join([f"«{u}»" for u in unmatched], reg)))
    lines.append(text("estimates", reg))
    if not any(s["priority"] in ("must_see", "interest") for s in plan["stops"]):
        lines.append(text("tip", reg))
    return "\n".join(lines)